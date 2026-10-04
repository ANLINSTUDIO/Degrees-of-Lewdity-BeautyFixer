/* ======================================
   美化修正 BeautyFixer
   游戏内修正服装/五官图像：移动、缩放、画笔、橡皮；
   替换原图生效（IndexedDB 持久化，重进游戏自动应用），支持导出/导入分享。
   参与AI：GLM-5.3-Flash、Deepseek-V4.1-Flash （Trea），耗时3天，消耗3000左右积分。
   Needmeet 参与指导。
   ====================================== */
const BF = {
    PREFIXES: ["img/clothes/", "img/face/", "img/hair/"],  // 可修正的图像路径白名单（头发在游戏里走 img/hair/，与 clothes/face 同级）
    MODEL_H: 256,        // 玩家侧栏模型画布高（Renderer.CanvasModels.main）
    MAX_UNDO: 20,
    db: null,            // IndexedDB 句柄
    store: new Map(),    // src -> { mode, img, tf, scale, dataURL, fileW, fileH, updatedAt }
    groups: new Map(),   // 套装组修正 id("槽位/名称") -> { tf:[x,y], updatedAt }——主文件的位移，同套新部件自动套用
    seen: new Map(),     // src -> 原始 HTMLImageElement（选图面板数据源，含真实文件尺寸）
};
window.BF = BF;

/* ---------- 小工具 ---------- */
BF.h = function(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
BF.shortName = function(src) { const p = src.split("/"); return p.slice(-3).join("/"); };
BF.toast = function(msg) {
    document.querySelectorAll(".bfToast").forEach(e => e.remove());
    const t = BF.h(`<div class="bfToast">${msg}</div>`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
};

/* ---------- 文件读写（手机 WebView 适配） ----------
   安卓 APK 里游戏把所有 saveAs(...) 调用都换成了 cordova.plugins.saveDialog.saveFile(blob, 名字)（内嵌
   cordova-plugin-save-dialog）；电脑端改用 File System Access 的 showSaveFilePicker 直接写盘——游戏是用 file://
   打开的本地页，FileSaver 的 <a download> 在那儿会被 Chrome 当成打开页面。读游戏原图同理：file:// 下 XHR/fetch 常被拦，
   能走 getHtmlTagSrcHook().requestImageBySrc() 就走它；全走不通时桌面端退回 window.open 新开页面看图，右键另存。 */
BF.dataURLToBlob = function(dataURL) {
    const s = String(dataURL), i = s.indexOf(",");
    if (i < 0) throw new Error("不是有效的 data URL");
    const mime = /^data:([^;,]*)/.exec(s)?.[1] || "application/octet-stream";
    let data = s.slice(i + 1);
    if (/%[0-9A-Fa-f]{2}/.test(data.slice(0, 256))) data = decodeURIComponent(data);   // 少数来源会顺手做 URL 转义
    const bin = atob(data.replace(/\s+/g, ""));   // 换行/空格先剥掉（社交平台、导出工具常插）
    const u8 = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    return new Blob([u8], { type: mime });
};
// 统一的落盘出口。接口按两端实情核定：安卓 APK 的 index.html 把每一处 saveAs(...) 都换成了
// cordova.plugins.saveDialog.saveFile(blob, 名字)（APK 里装了 cordova-plugin-save-dialog，直接落进系统
// 「保存到文件」），它必须排第一——APK 里的 window.saveAs 虽然存在（FileSaver 挂的），点了不弹框也不报错，
// 排在前面就会“假装成功”。电脑端改用 showSaveFilePicker：游戏从 file:// 打开，FileSaver 的 <a download>
// 会被 Chrome 当成打开页面、把游戏界面冲掉。
BF.saveBlob = async function(blob, name) {
    const savers = [
        window.cordova?.plugins?.saveDialog?.saveFile,   // 安卓 APK 专用：游戏「另存为」用的就是它，返回 Promise
        window.showSaveFilePicker && (async (blob, name) => {   // 电脑端：调起系统「另存为」直接写盘（file:// 下 <a download> 会被 Chrome 当成打开页面）
            const w = await (await window.showSaveFilePicker({ suggestedName: name })).createWritable();
            await w.write(blob); await w.close();
        }),
        window.saveAs,                                   // 兜底：FileSaver 的 saveAs
    ].filter(f => typeof f === "function");
    for (const f of savers) {
        try {
            const r = f(blob, name);
            if (r && typeof r.then === "function") await r;   // 原生桥可能返回 Promise：被拒也算失败，继续试下一个
            return true;
        } catch (e) {
            if (e?.name === "AbortError") return true;   // 用户在保存框里点了取消：算完成，别再去试下一个（下一个会把文件当页面打开）
            console.warn("[BF] 保存接口调用失败，试下一个", e);
        }
    }
    try {   // 移动端：系统分享面板里有「保存到文件/网盘」
        const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
    } catch (e) {
        if (e?.name === "AbortError") return true;   // 用户自己取消分享，不算失败
        console.warn("[BF] 分享保存不可用", e);
    }
    try {   // 桌面浏览器兜底
        const url = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = url; a.download = name; a.style.display = "none";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 40000);
        return true;
    } catch (e) { console.warn("[BF] 落盘失败", e); return false; }
};
// 模态输入框（替代浏览器原生 prompt：iOS Safari 禁用/不弹原生框）
BF.prompt = function(title, value, cb) {
    BF.ed?.prompt?.remove();
    if (!BF.ed) return;
    const m = BF.h(`<div class="bfModal"><div class="bfModalBox">
        <div class="bfModalTitle">${title}</div>
        <input type="text" class="bfModalInput">
        <div class="bfModalBtns"><button class="bfBtn bfPrimary" data-a="ok">确定</button><button class="bfBtn" data-a="no">取消</button></div>
    </div></div>`);
    const inp = m.querySelector(".bfModalInput");
    inp.value = value ?? "";
    const close = ok => { const n = inp.value.trim(); m.remove(); BF.ed.prompt = null; if (ok && n) cb(n); };
    m.addEventListener("click", e => {
        const a = e.target.dataset?.a;
        if (a === "ok") close(true);
        else if (a === "no" || e.target === m) close(false);
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") close(true); });
    BF.ed.panel.appendChild(m);
    BF.ed.prompt = m;
    setTimeout(() => inp.focus(), 50);
};
BF.confirm = function(title, cb) {   // 确认框：复用 .bfModal 样式（BF.prompt 必带输入框且空值直接取消，当不了是非确认，故单列一个）
    const box = BF.ed?.panel || document.querySelector("#bfPicker");
    if (!box) { cb(); return; }
    const m = BF.h(`<div class="bfModal"><div class="bfModalBox">
        <div class="bfModalTitle">${title}</div>
        <div class="bfModalBtns"><button class="bfBtn bfPrimary" data-a="ok">确定</button><button class="bfBtn" data-a="no">取消</button></div>
    </div></div>`);
    m.addEventListener("click", e => {
        const a = e.target.dataset?.a;
        if (a === "ok") { m.remove(); cb(); }
        else if (a === "no" || e.target === m) m.remove();
    });
    box.appendChild(m);
};

/* ---------- IndexedDB ---------- */
BF.openDB = function() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("BeautyFixerDB", 2);   // v2 增 groups 表（组修正）
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("fixes")) db.createObjectStore("fixes", { keyPath: "src" });
            if (!db.objectStoreNames.contains("groups")) db.createObjectStore("groups", { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
};
BF.tx = function(mode) { return BF.db.transaction("fixes", mode).objectStore("fixes"); };
BF.txG = function(mode) { return BF.db.transaction("groups", mode).objectStore("groups"); };
BF.persist = function(row) { if (BF.db) { try { BF.tx("readwrite").put(row.pieces ? { ...row, pieces: row.pieces.map(BF.plainPiece) } : row); } catch (e) { console.error("[BF] 写库失败", e); } } };   // 落库前 pieces 过一遍纯化：运行对象（Image/Canvas/函数）进不了 IndexedDB，否则 put 抛 DataCloneError 整条写不进
BF.erase = function(src) { if (BF.db) { try { BF.tx("readwrite").delete(src); } catch (e) { console.error("[BF] 删库失败", e); } } };
BF.persistGroup = g => { if (BF.db) { try { BF.txG("readwrite").put(g); } catch (e) { console.error("[BF] 写组库失败", e); } } };
BF.eraseGroup = id => { if (BF.db) { try { BF.txG("readwrite").delete(id); } catch (e) { console.error("[BF] 删组库失败", e); } } };
// 1×1 透明 PNG 占位（纯位移修正用，干净画布生成、不涉跨域）；同步到导出判断（dataURL === BF.EMPTY 即纯位移）
BF.EMPTY_PNG = () => BF.EMPTY || (BF.EMPTY = (() => { const c = document.createElement("canvas"); c.width = c.height = 1; return c.toDataURL("image/png"); })());

/* 编辑器按钮图标：Assets 白色线条 icon 转 Base64 内联（无额外请求；200×200 源图，显示尺寸见 .bfIco） */
BF.ICONS = {
    undo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAKOmlDQ1BzUkdCIElFQzYxOTY2LTIuMQAASImdU3dYU3cXPvfe7MFKiICMsJdsgQAiI+whU5aoxCRAGCGGBNwDERWsKCqyFEWqAhasliF1IoqDgqjgtiBFRK3FKi4cfaLP09o+/b6vX98/7n2f8zvn3t9533MAaAEhInEWqgKQKZZJI/292XHxCWxiD6BABgLYAfD42ZLQKL9oAIBAXy47O9LfG/6ElwOAKN5XrQLC2Wz4/6DKl0hlAEg4ADgIhNl8ACQfADJyZRJFfBwAmAvSFRzFKbg0Lj4BANVQ8JTPfNqnnM/cU8EFmWIBAKq4s0SQKVDwTgBYnyMXCgCwEAAoyBEJcwGwawBglCHPFAFgrxW1mUJeNgCOpojLhPxUAJwtANCk0ZFcANwMABIt5Qu+4AsuEy6SKZriZkkWS0UpqTK2Gd+cbefiwmEHCHMzhDKZVTiPn86TCtjcrEwJT7wY4HPPn6Cm0JYd6Mt1snNxcrKyt7b7Qqj/evgPofD2M3se8ckzhNX9R+zv8rJqADgTANjmP2ILygFa1wJo3PojZrQbQDkfoKX3i35YinlJlckkrjY2ubm51iIh31oh6O/4nwn/AF/8z1rxud/lYfsIk3nyDBlboRs/KyNLLmVnS3h8Idvqr0P8rwv//h7TIoXJQqlQzBeyY0TCXJE4hc3NEgtEMlGWmC0S/ycT/2XZX/B5rgGAUfsBmPOtQaWXCdjP3YBjUAFL3KVw/XffQsgxoNi8WL3Rz3P/CZ+2+c9AixWPbFHKpzpuZDSbL5fmfD5TrCXggQLKwARN0AVDMAMrsAdncANP8IUgCINoiId5wIdUyAQp5MIyWA0FUASbYTtUQDXUQh00wmFohWNwGs7BJbgM/XAbBmEEHsM4vIRJBEGICB1hIJqIHmKMWCL2CAeZifgiIUgkEo8kISmIGJEjy5A1SBFSglQge5A65FvkKHIauYD0ITeRIWQM+RV5i2IoDWWiOqgJaoNyUC80GI1G56Ip6EJ0CZqPbkLL0Br0INqCnkYvof3oIPoYncAAo2IsTB+zwjgYFwvDErBkTIqtwAqxUqwGa8TasS7sKjaIPcHe4Ag4Bo6Ns8K54QJws3F83ELcCtxGXAXuAK4F14m7ihvCjeM+4Ol4bbwl3hUfiI/Dp+Bz8QX4Uvw+fDP+LL4fP4J/SSAQWARTgjMhgBBPSCMsJWwk7CQ0EU4R+gjDhAkikahJtCS6E8OIPKKMWEAsJx4kniReIY4QX5OoJD2SPcmPlEASk/JIpaR60gnSFdIoaZKsQjYmu5LDyALyYnIxuZbcTu4lj5AnKaoUU4o7JZqSRllNKaM0Us5S7lCeU6lUA6oLNYIqoq6illEPUc9Th6hvaGo0CxqXlkiT0zbR9tNO0W7SntPpdBO6Jz2BLqNvotfRz9Dv0V8rMZSslQKVBEorlSqVWpSuKD1VJisbK3spz1NeolyqfES5V/mJClnFRIWrwlNZoVKpclTlusqEKkPVTjVMNVN1o2q96gXVh2pENRM1XzWBWr7aXrUzasMMjGHI4DL4jDWMWsZZxgiTwDRlBjLTmEXMb5g9zHF1NfXp6jHqi9Qr1Y+rD7IwlgkrkJXBKmYdZg2w3k7RmeI1RThlw5TGKVemvNKYquGpIdQo1GjS6Nd4q8nW9NVM19yi2ap5VwunZaEVoZWrtUvrrNaTqcypblP5UwunHp56SxvVttCO1F6qvVe7W3tCR1fHX0eiU65zRueJLkvXUzdNd5vuCd0xPYbeTD2R3ja9k3qP2OpsL3YGu4zdyR7X19YP0Jfr79Hv0Z80MDWYbZBn0GRw15BiyDFMNtxm2GE4bqRnFGq0zKjB6JYx2ZhjnGq8w7jL+JWJqUmsyTqTVpOHphqmgaZLTBtM75jRzTzMFprVmF0zJ5hzzNPNd5pftkAtHC1SLSotei1RSydLkeVOy75p+Gku08TTaqZdt6JZeVnlWDVYDVmzrEOs86xbrZ/aGNkk2Gyx6bL5YOtom2Fba3vbTs0uyC7Prt3uV3sLe759pf01B7qDn8NKhzaHZ9Mtpwun75p+w5HhGOq4zrHD8b2Ts5PUqdFpzNnIOcm5yvk6h8kJ52zknHfBu3i7rHQ55vLG1clV5nrY9Rc3K7d0t3q3hzNMZwhn1M4Ydjdw57nvcR+cyZ6ZNHP3zEEPfQ+eR43HfU9DT4HnPs9RL3OvNK+DXk+9bb2l3s3er7iu3OXcUz6Yj79PoU+Pr5rvbN8K33t+Bn4pfg1+4/6O/kv9TwXgA4IDtgRcD9QJ5AfWBY4HOQctD+oMpgVHBVcE3w+xCJGGtIeioUGhW0PvzDKeJZ7VGgZhgWFbw+6Gm4YvDP8+ghARHlEZ8SDSLnJZZFcUI2p+VH3Uy2jv6OLo27PNZstnd8QoxyTG1MW8ivWJLYkdjLOJWx53KV4rXhTflkBMiEnYlzAxx3fO9jkjiY6JBYkDc03nLpp7YZ7WvIx5x+crz+fNP5KET4pNqk96xwvj1fAmFgQuqFowzufyd/AfCzwF2wRjQndhiXA02T25JPlhinvK1pSxVI/U0tQnIq6oQvQsLSCtOu1Velj6/vSPGbEZTZmkzKTMo2I1cbq4M0s3a1FWn8RSUiAZXOi6cPvCcWmwdF82kj03u03GlElk3XIz+Vr5UM7MnMqc17kxuUcWqS4SL+pebLF4w+LRJX5Lvl6KW8pf2rFMf9nqZUPLvZbvWYGsWLCiY6XhyvyVI6v8Vx1YTVmdvvqHPNu8krwXa2LXtOfr5K/KH17rv7ahQKlAWnB9ndu66vW49aL1PRscNpRv+FAoKLxYZFtUWvRuI3/jxa/svir76uOm5E09xU7FuzYTNos3D2zx2HKgRLVkScnw1tCtLdvY2wq3vdg+f/uF0uml1TsoO+Q7BstCytrKjco3l7+rSK3or/SubKrSrtpQ9WqnYOeVXZ67Gqt1qouq3+4W7b6xx39PS41JTelewt6cvQ9qY2q7vuZ8XbdPa1/Rvvf7xfsHD0Qe6Kxzrqur164vbkAb5A1jBxMPXv7G55u2RqvGPU2spqJDcEh+6NG3Sd8OHA4+3HGEc6TxO+PvqpoZzYUtSMvilvHW1NbBtvi2vqNBRzva3dqbv7f+fv8x/WOVx9WPF5+gnMg/8fHkkpMTpySnnpxOOT3cMb/j9pm4M9c6Izp7zgafPX/O79yZLq+uk+fdzx+74Hrh6EXOxdZLTpdauh27m39w/KG5x6mnpde5t+2yy+X2vhl9J654XDl91efquWuB1y71z+rvG5g9cON64vXBG4IbD29m3Hx2K+fW5O1Vd/B3Cu+q3C29p32v5kfzH5sGnQaPD/kMdd+Pun97mD/8+Kfsn96N5D+gPygd1Rute2j/8NiY39jlR3MejTyWPJ58UvCz6s9VT82efveL5y/d43HjI8+kzz7+uvG55vP9L6a/6JgIn7j3MvPl5KvC15qvD7zhvOl6G/t2dDL3HfFd2Xvz9+0fgj/c+Zj58eNv94Tz+8WoiUIAAAAJcEhZcwAACxMAAAsTAQCanBgAAAv4SURBVHic7d17jF1VFQbw7zudVrC1PKpQREAroQiGVjFGicEEIiKJhNiK1JaXkBgxPqII/6hYBCkoKDU81AhqUEFbjMYAEiMkpSgviSIIiC9ArTxaWmiltJ1llt0Xh6Gzmc7de5/H/X7JTXunnXtPp/PN3vuctdehmUFEtq0a4+MiooCIxCkgIhEKiEiEAiISoYCIRCggIhEKiEiEAiISoYCIRCggIhEKiEiEAiISoYCIRCggIhEKiEiEAiISoYCIRCggIhEKiEiEAiISoYCIRCggIhEKiEiEAiISoYCIRCggIhEKiEiEAiISoYCIRCggIhEKiEiEAiISoYCIRAwhs1WrVqGlt3k73sxOJvlNAFeXelOSaILR/2cWnvvx+cOf+6Oqquf/bPTz0Z/f+7zev7H36/Dw8Av+bu89xmPmzJlodUBaOqq+H8B5JPcEMBfAFgA/rvvApDwF5MVfj3kAvgzAw+F2AXC5/xAEsKzm45PCtAZ5YTjmh3DsNerPdgXwjRAefc0GiP6zt5oM4NgxwjEyJN8KIZlU+PikJgrI1pHjAwCWAHjNS/zd3nTLRxqFZAAMekD8378AwJciI8e2RpJLQqiaccpJshn0gJwA4JztCEfPDAAXA1iU6bikIQY5IB8C8AUAe0/w818Z1iwnJT4uaZBqgMPxeQD79Pk6uwM4N7yedNAgBuTkROHoeTWAswGckuj1pEEGLSDHAzgrYTh6/KLiYo0k3TNIAVkUFuSpwzEyJH427OM6u9Udg1JqsnA7T+VO1G5eP5f5PaSgQQiIX+c4r0A4NgC4lORXQt2WdEDXA+IX884vEI71AC4j6We0nsr8XlJQVwMyKVJ4mNrTXshI0tc3azO/lxQ21PGS9RLhuJykr28Ujg4a6mjJ+gUlplUkLwvrG02rOmqoYyXr8wutOTaQ/HqoANbI0WFVh9YcpRbkG0l+NbyXwtFxXQgIw3WOcwuEY0s4jesPTasGQBcCciKAL/ZRlTtuJH29oXAMkKGOVOWWCIefxr1I4RgsbQ5I6qrcMYXTuBcqHIOnrQE5qc/NTuNlJJeE08ZakA+goZaWrC8uEA5fkPvFRoVjgLUtIH626pwC4Xia5NdCBfCzmd9LGqxNAfngOFvz9OsZM7uR5PLQnGEKBoeF0XJN3QfSFG0JyHGFwuG8k/JUAKeHrw8HLCCrATweHmsBbA6jqIdmE4D/AHgglPd3XtMDwnCFvERtVc90kke2tCN9agbgOR9VAfwrBGUdgFsArAgfe7TLa7ShhpePzCscDnnxD6iX+YOkTzf/x8wOA/BvAL8DcGcIy7oQFv/4RnREUwNSsmRdJmZ3kkeY2RHh+RMAfgng9vDrH8P0rNWYeyoxgRvoDIX7cywpcYVc0jOzW8NWAA/KY76u0w100uiFo0RVrmRC8hAAs83sJpLXhDXLKrRQ1bA1x4Iwcigc7TeDpE+TLzMz74j/nnB2sFVnBZsSEI7oW6VpVXfQexiTPJrkFQCuAnB0g77vWjPFOqFQ+YjUF5SZAI4heTCAN4SZQuNVDSlZX1yiKlcaYS8AZwJYGioVGq0alJJ1aZSdAXzYzHx/zaFosKGadwLmaCQt7TDF151m9qpwa7ufNbEj5VCNJet+ywCtOQZbBeBdJPc2M+9Ks7xpIaljirUoNFhQOKT3Q/pAkr4OfV/TTgMP1VCyXqLLurTPAWGXqPt5U+q5qsIl67pCLmMi+UYAZwB4ExqiRECmhduTXVJoP4e0GMmDSH4EwGsxIFOsg8K6w8uhtVOt+RhOw04OZ5qq8PtSdjCzhSTXmtlZJNd0PSAVSW+Zs6XAe0l/vKx20vDwsK8HppLcOYRkXwCzwq2v/WO5TTKzj5mZb8i6mOSGLgdkZdNO3clLum7kE5Kv8OpcAIeZ2ZEA9gtXwXfIfBynAvgTgGXo8n4QaZfe/gyO2rdhZl5xvSOAOWY2j+RRAF6XubHFT0h+EsDDdewHqbvURNplS9ifvpLkZ0meGErZe80dcnivmR1f1/URBUQmagOA2wB8jqR/Ey8N4cmxDHh3ONkzsOXu0l7rQtOG+8xsE8mPhlP7Kb01TOm8SURRGkEklSe9Aw1J3zJ9R+LX9s4qhwPwC4lFKSCS0moAN5D8dJh+pTTXzI71k0ojH7kpIJLDCpKfSRySl3tDDzM7SgGRroTkdAD3JHzN2d4IotcWaLytgfqhgEhOt3iXfJKPJHo9T8T+JL1pnQIinbAcwLUJqyn2MrM3a4olrcKxf6L7RcTvAfhNorfaxczeiUIUEEmC8SnPb0l+P9w6oV/TSB7mzbQ1xZLOMLObQwvSVNMsv3iYPSEKiEyIhfl/VY3vW4jkvSSvTbSVdpqZvSU0eshKAZFizGylmaUYRXyvyhySXl2clQIi243kuEeOUZ/3UFVVK1Icgm/fJukXD7NSQGTc2P+1B1+k/yPR4fie9TnITAGR0u4LuwT7NTls3spKAZHSfk/yhwleZ8rw8LB3ic9KAZEopr/W4Juq7k30vet75bNSQKStJpXosKKASB2eSvAaU0hmb0SoLbeyTSM6mSBTQNaHexZOlB/gnshMI4i8SIEap2cBeFO4fmW/DtK5EaRECXRX9e5jXuDruAHAIyS9Y2M/piOzTgWk1B6BLiv09RsGsCnB6+Tu7NitgEj/SpSQY+vUKMUCO9VOxTFpDSJ12BHAHn2+hiUsWxmTAiJ1jCZTwo07+7HZzJ5AZppiSR0hqRKtdXL1A36eRhCpwx4JXmNTolPFUQqIlD47uEuiexBurqoq+701NMWScTGzVFfX9/F7o6c4pBJTLAVEtouFcPSxNplpZik2Om0Me0uy0hRLStoJwNsT/WD20eMhZKYRREqOIrPMzG+G069NZvbrTDfseQGNIFJy/8YhifaRryd5U6JylSgFRPpi41+w72dm8xPVT20keRdJXQeRTpgK4BgAb0vwWn4F/a4SC3SngEjWEcW2PvcbcC5MNHqsJXl9uDdidlqkSxI2ah9Jb2+JmXnV7qkADkz0VutI3o1CNIJITtMA+F1vFyV8zX8m6ooyLgqI5DQfwHGhejcF38d+Y6KmD+OigEgu7wBwGklvEZqy6dwPUJDWIJLaFD9bZWYXATg44ev66HF9iavnI2kEkdQ7BU8B8N3E4XB3k7wGhWkEkVSmA7iA5IIM3UY2hLXHgyhMAZF+EcChAM4EcHjCBflIt5NchhooINKPuQAWm5lf43h9jjcws1UkfwTgftRAAZHttT8Avw3zXDM7JFwlz4bkrSEgtTQ8U0DkpaZPQwBmeyVu2Ojk9waclWhfefzNSb+f4YUAnkRNuhSQ3cJe5xkAttR9MC3kZzR3Db/6vvHdzGyn8HxPkh6SmaUOxsz+CmCpjyCoUfaAFGwFuq+ZfYLkAaG1pWyfKpx9mhRuTMMaj8X3eXwbwA2oWZcC4nU/s0JTAGm3KwF8B8DTdR9Ily4U+qjxXN0HIX3zrbRLSGZvKzpoaxBpv/tIng3A1x+NoIBIU9xP8lMAfoEG6dIUS9prBcnTmhYOpxFEUPPZql+RXALgZjSQAiJ1WQfgagBn+D5zNJQCInV41MzOJ3lFqNRtLAVESjIADwA4C8BPQ3/dRlNApAjbWpV7pRcemtk9bSkHUkAkt2c8GACuChueijVcSEEBkWy4dbTwYNwG4DG0kAIiqRnJ68zs2nDq9i9oMQVEkKhf7sqqqm41M59G3VGyuVtOCohMxBoz+zOA1SRXAngcgDeUvrNrWw26FJDJCe69Lf/3LICHQz8q/9o+ERbY/vBNTA+GnX5/QId1KSB+wenvodW+TMxwWEx7CciTZuZNold7V3aSfwsl6I+Z2QNha0GnRottYcENTSKto2pekQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQkQgFRCRCARGJUEBEIhQQEYztv2017PVmdMWCAAAAAElFTkSuQmCC",
    redo: "data:image/png;base64,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",
    move: "data:image/png;base64,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",
    brush: "data:image/png;base64,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",
    eraser: "data:image/png;base64,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",
    marquee: "data:image/png;base64,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",
    group: "data:image/png;base64,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",
    split: "data:image/png;base64,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",
    scale: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAKOmlDQ1BzUkdCIElFQzYxOTY2LTIuMQAASImdU3dYU3cXPvfe7MFKiICMsJdsgQAiI+whU5aoxCRAGCGGBNwDERWsKCqyFEWqAhasliF1IoqDgqjgtiBFRK3FKi4cfaLP09o+/b6vX98/7n2f8zvn3t9533MAaAEhInEWqgKQKZZJI/292XHxCWxiD6BABgLYAfD42ZLQKL9oAIBAXy47O9LfG/6ElwOAKN5XrQLC2Wz4/6DKl0hlAEg4ADgIhNl8ACQfADJyZRJFfBwAmAvSFRzFKbg0Lj4BANVQ8JTPfNqnnM/cU8EFmWIBAKq4s0SQKVDwTgBYnyMXCgCwEAAoyBEJcwGwawBglCHPFAFgrxW1mUJeNgCOpojLhPxUAJwtANCk0ZFcANwMABIt5Qu+4AsuEy6SKZriZkkWS0UpqTK2Gd+cbefiwmEHCHMzhDKZVTiPn86TCtjcrEwJT7wY4HPPn6Cm0JYd6Mt1snNxcrKyt7b7Qqj/evgPofD2M3se8ckzhNX9R+zv8rJqADgTANjmP2ILygFa1wJo3PojZrQbQDkfoKX3i35YinlJlckkrjY2ubm51iIh31oh6O/4nwn/AF/8z1rxud/lYfsIk3nyDBlboRs/KyNLLmVnS3h8Idvqr0P8rwv//h7TIoXJQqlQzBeyY0TCXJE4hc3NEgtEMlGWmC0S/ycT/2XZX/B5rgGAUfsBmPOtQaWXCdjP3YBjUAFL3KVw/XffQsgxoNi8WL3Rz3P/CZ+2+c9AixWPbFHKpzpuZDSbL5fmfD5TrCXggQLKwARN0AVDMAMrsAdncANP8IUgCINoiId5wIdUyAQp5MIyWA0FUASbYTtUQDXUQh00wmFohWNwGs7BJbgM/XAbBmEEHsM4vIRJBEGICB1hIJqIHmKMWCL2CAeZifgiIUgkEo8kISmIGJEjy5A1SBFSglQge5A65FvkKHIauYD0ITeRIWQM+RV5i2IoDWWiOqgJaoNyUC80GI1G56Ip6EJ0CZqPbkLL0Br0INqCnkYvof3oIPoYncAAo2IsTB+zwjgYFwvDErBkTIqtwAqxUqwGa8TasS7sKjaIPcHe4Ag4Bo6Ns8K54QJws3F83ELcCtxGXAXuAK4F14m7ihvCjeM+4Ol4bbwl3hUfiI/Dp+Bz8QX4Uvw+fDP+LL4fP4J/SSAQWARTgjMhgBBPSCMsJWwk7CQ0EU4R+gjDhAkikahJtCS6E8OIPKKMWEAsJx4kniReIY4QX5OoJD2SPcmPlEASk/JIpaR60gnSFdIoaZKsQjYmu5LDyALyYnIxuZbcTu4lj5AnKaoUU4o7JZqSRllNKaM0Us5S7lCeU6lUA6oLNYIqoq6illEPUc9Th6hvaGo0CxqXlkiT0zbR9tNO0W7SntPpdBO6Jz2BLqNvotfRz9Dv0V8rMZSslQKVBEorlSqVWpSuKD1VJisbK3spz1NeolyqfES5V/mJClnFRIWrwlNZoVKpclTlusqEKkPVTjVMNVN1o2q96gXVh2pENRM1XzWBWr7aXrUzasMMjGHI4DL4jDWMWsZZxgiTwDRlBjLTmEXMb5g9zHF1NfXp6jHqi9Qr1Y+rD7IwlgkrkJXBKmYdZg2w3k7RmeI1RThlw5TGKVemvNKYquGpIdQo1GjS6Nd4q8nW9NVM19yi2ap5VwunZaEVoZWrtUvrrNaTqcypblP5UwunHp56SxvVttCO1F6qvVe7W3tCR1fHX0eiU65zRueJLkvXUzdNd5vuCd0xPYbeTD2R3ja9k3qP2OpsL3YGu4zdyR7X19YP0Jfr79Hv0Z80MDWYbZBn0GRw15BiyDFMNtxm2GE4bqRnFGq0zKjB6JYx2ZhjnGq8w7jL+JWJqUmsyTqTVpOHphqmgaZLTBtM75jRzTzMFprVmF0zJ5hzzNPNd5pftkAtHC1SLSotei1RSydLkeVOy75p+Gku08TTaqZdt6JZeVnlWDVYDVmzrEOs86xbrZ/aGNkk2Gyx6bL5YOtom2Fba3vbTs0uyC7Prt3uV3sLe759pf01B7qDn8NKhzaHZ9Mtpwun75p+w5HhGOq4zrHD8b2Ts5PUqdFpzNnIOcm5yvk6h8kJ52zknHfBu3i7rHQ55vLG1clV5nrY9Rc3K7d0t3q3hzNMZwhn1M4Ydjdw57nvcR+cyZ6ZNHP3zEEPfQ+eR43HfU9DT4HnPs9RL3OvNK+DXk+9bb2l3s3er7iu3OXcUz6Yj79PoU+Pr5rvbN8K33t+Bn4pfg1+4/6O/kv9TwXgA4IDtgRcD9QJ5AfWBY4HOQctD+oMpgVHBVcE3w+xCJGGtIeioUGhW0PvzDKeJZ7VGgZhgWFbw+6Gm4YvDP8+ghARHlEZ8SDSLnJZZFcUI2p+VH3Uy2jv6OLo27PNZstnd8QoxyTG1MW8ivWJLYkdjLOJWx53KV4rXhTflkBMiEnYlzAxx3fO9jkjiY6JBYkDc03nLpp7YZ7WvIx5x+crz+fNP5KET4pNqk96xwvj1fAmFgQuqFowzufyd/AfCzwF2wRjQndhiXA02T25JPlhinvK1pSxVI/U0tQnIq6oQvQsLSCtOu1Velj6/vSPGbEZTZmkzKTMo2I1cbq4M0s3a1FWn8RSUiAZXOi6cPvCcWmwdF82kj03u03GlElk3XIz+Vr5UM7MnMqc17kxuUcWqS4SL+pebLF4w+LRJX5Lvl6KW8pf2rFMf9nqZUPLvZbvWYGsWLCiY6XhyvyVI6v8Vx1YTVmdvvqHPNu8krwXa2LXtOfr5K/KH17rv7ahQKlAWnB9ndu66vW49aL1PRscNpRv+FAoKLxYZFtUWvRuI3/jxa/svir76uOm5E09xU7FuzYTNos3D2zx2HKgRLVkScnw1tCtLdvY2wq3vdg+f/uF0uml1TsoO+Q7BstCytrKjco3l7+rSK3or/SubKrSrtpQ9WqnYOeVXZ67Gqt1qouq3+4W7b6xx39PS41JTelewt6cvQ9qY2q7vuZ8XbdPa1/Rvvf7xfsHD0Qe6Kxzrqur164vbkAb5A1jBxMPXv7G55u2RqvGPU2spqJDcEh+6NG3Sd8OHA4+3HGEc6TxO+PvqpoZzYUtSMvilvHW1NbBtvi2vqNBRzva3dqbv7f+fv8x/WOVx9WPF5+gnMg/8fHkkpMTpySnnpxOOT3cMb/j9pm4M9c6Izp7zgafPX/O79yZLq+uk+fdzx+74Hrh6EXOxdZLTpdauh27m39w/KG5x6mnpde5t+2yy+X2vhl9J654XDl91efquWuB1y71z+rvG5g9cON64vXBG4IbD29m3Hx2K+fW5O1Vd/B3Cu+q3C29p32v5kfzH5sGnQaPD/kMdd+Pun97mD/8+Kfsn96N5D+gPygd1Rute2j/8NiY39jlR3MejTyWPJ58UvCz6s9VT82efveL5y/d43HjI8+kzz7+uvG55vP9L6a/6JgIn7j3MvPl5KvC15qvD7zhvOl6G/t2dDL3HfFd2Xvz9+0fgj/c+Zj58eNv94Tz+8WoiUIAAAAJcEhZcwAACxMAAAsTAQCanBgAABOWSURBVHic7Z1rsF1lecf/zwoxCUnIpRRDqJaCWmv7wWq5tJXS6VipknDJDQiBkEBIIDLtONo6OG0/2G9g7Uxn1JYkhEuAhFzQqYUyxTadWA1OvRRocUBkRsXTyE3CTXKy/50nvDtsDme/e6+13nV53/38ZtYkOdln73XWWb/13p7nfYQkDMOYnKzP1w3DMEEMw48JYhgeTBDD8GCCGIYHE8QwPJgghuHBBDEMDyaIYXgwQQzDgwliGB5MEMPwYIIYhgcTxDA8mCCG4cEEMQwPJohheDBBDMODCWIYHkwQw/BgghiGBxPEMDyYIIbhwQQxDA8miGF4MEEMw8MxqJmxsbGjfyc5W0TOILmU5Fki8ssAfoF2XZ9nST4lIvcC2CMiTyIBSM4XkdNJXuiu/XwAr6E9TAHwjF77LMv+qdPp7Myy7OjNs2DBglpOQurem7dHkLcD+DzJSxAPKsqnAOwAMI54eQfJ2wCcjUgg+c0sy/4GwH0ADqcuyDQAXyZ5DuLjMIBzReRfECfvAnAPyd9EfLwE4E9EZF9dgtQ+Bul0OtLpdK6KVA5lCsk/BXBcVR+gD62Kjukk/ypSOZSZ7trPRE3ULoiI/AaATyJiROSjAE6PUJAzdcyBiBGRZQBOS3aQrgNDACcjckj+EYB/r2IskmWVPbfeR3IW4mac5Gnu2qcnCIDZSACS73XXL7ggIoKKOBXxIyQr6962YR0k5tmfXl7RIRXi4mmkwXhdH9REC5IKdwA4VMUbVzizuJfkuIjY731IbCW9GIdE5F9FhNodCn1UyKN63lV+QGqYIMVYW2X3qgrp3PGsiNxIspKWL0VMkPysB3B7Vd2rqiH5gIisFJEnmj6XGEixL3rYxfEEgaTGXj2fZdl+knfVNb1YMTsBPExyOYDVInKKNlyBP+MggBmx32NRn/xEROQGAFtIhlppVdGec0F8B9zMVSo8CuCzAO50UQHamwgyO0BSr9MKEfl07PdY1Cc/EZJLNEZKRB5w/276lGLg8VBvxDeu91luxfttiJzUxiCnktwFQLsOdcwKGXgjNMZxvohoV1TjvaK/+KkJoswhuRnARd0vmCjVwTe30heIyJcALEQipCiIMpvkzQBW9n7RRKms1VCWODnqiUOviaTGIBOYQXKLE0JXvY/SlcTGKPnh5NdsqZPjeCRGqi1Il2kqCYBLJ/tPa1FKtRhdlovITSnKMQqCdCXZBKBvaq+JUkgMRWeqVI55SJRREESZ7lqSi30vMlGGFkNZoWtOIjIHCRODIPpb+qnucBFAEh24D9wkYpQlGUKMrhw3i0jZ3J4XATyCFhOFICR3krwmQD5DVxJvS6LUGGEbkxhw107lOBblN2DYICKfR4uJQZDM7YJyN8mrA7Qk05wkRxYTBxGTIMPkpfe+drK/D2CF61aVlUNDd64CsE3TgNFiYpnm7QYf7iGZuVmTeSVbkltERDPT9gz7TW0XpeJp62UANouIBiCWQdMErgRwl7uerc4wjaEF6TLV/bmLpIac/zzAOolunnZegHNLnSWu5Qix4cNlLl0gCmISpPfxqN2t9SQ1pLrsPkvbSC4q+T4pc76IaMsRYrONld1F27a3xjEKMpHtANaR1JmQMuhTUSWxlmRyObYAmBuo5bgzJjliF6QryVUBJNF8iFtJnh/ovFLgPBHRBVbd1Losl8fUrUpJkK4kVwbobumC19bYdx4MxKKA4SNXANCxHmJrPVIRBG639XUuzbMM2pXYRPICjC5dOU4I8F5rANyCiIlFkGF2ENlOUufWny/5Wdql0HySpRg9FovIPwQKWV+rLXLvF2JrPaIRREROlNcZtLq9g6S2JM+W/Mj5JG8adjExoTFHqGSntbrajgSIQhC3kv4W+kiy062T/KzkZ85zUcBHMxMTRjMBvxhIjismkyPG1iMmQfJu0taN3dIgxzIcNyhUPgEuDCTHuG4hFPuYI1ZB+uJ5MumK+3UBJJnlQuUvSViOsmOOV134yK2T/WesrUcSggxAJfm41hYMlE+SkiSaQ/6PrlZk2ajc9f3kiJ0kBBnwhNodqCWZ7kvfjQzNId8UYJ3jIIBrfXLE3HokI8gQqCQbA0myOXJJNGR9c4A02YMANqbaciQnyBBPKg2V16fdG4Xai+eTbJ64pVAk6Izc5gBpsgedHEdXyFNsPZISZEi0/PEGt89uiN1SBmYmtkyOmwOErL84jBypkDWY15GHYLu1u/rsGwKk7+bKTGyYbg75jACzVdcOI0cKrUdTghS5MV8OfA7a3VofYMX9SGZiy8NSlrtkp7JyHHLxbqFbjrznJf0WjlNJuc09UCZ5oIKKTrt70nfnlsxMvFXLsel7ol0sc3LMDBR4uG2YF+ZsPX6Y8zz0d1a2i9xeQTqdzvMioumyeQaKuyoqeaYr7uKmPMuUFj5W03dFRIv3fBntSZPdHChNdmU32amC3Ph9OQuLvpRl2T8j4S7WIyT/NsfrX3I1P4YumJmTI7ulkHwB5VBJbie5GO1YIVc5QtQTvzSPHAWu/+Micv+wLya5r9PpPIaEBXnNRd0O2/9fH3iQ3i/p6upA6btNS3JegG5jb5rsHXm/KWdh0edE5HNDFhbVe+ev69x0vKlp3h+KiP4iH+z3ApLPuLDpbTVtDRM0fbehgfvvunyOXwrwXqvrSpMl+TURWSUifccjJB/WqGMA+0OVihsGqbsEwFNPvR4W5Z4eJwP4kO6wR/JMkj/QIpxZln290+loF+GbRT6j5M+k6wWbyvbd9RcqIh8RkbKr98MyleQ3AHww0IB8a5FvLDK92/19iYhWpTrHpT2/l+TLIvJfIqL3w1dE5LHuaxcuXDgSG8c96Y5/c+HWmg2oV+DHbs69CbQlUTSQr3Af3v2yVwHQwqK56HQKzUd8TETejwoyAWvkEXdsd5md4y7yQQupNkLTgnT5iTvagqbvdlx3pWjMkj5KzwKgExKHc31jsUW2jwboMrclE/AnbbkfRi3UJA8h9gLWB1BdS8q/VvKzrmyJHK3CBPHTTd8tujA1J9C+UsMwpWSarMaWGRMwQYZLurqmYBTw94q0QMPs0j7J8WDerpwLH7kitTTZkJggw4elFMlM/D7Jw3lv9izLihx359zy6BVXgsDk8GCCDE83x31YSXboID/nolmZKNjvuA30huHnKafJhsQEKdaS7PW85hdOjlUNTFVf6+qd6IpzP37kwkdGIp8jlWnemNgjIg+R/CyAM9yq9VQ31tC9uO4UkS+4/n0TLCH5GRHRcBddiJ3pBvAHXBzcdSLyREPnFh1Nr6Qf/XpviTDtU+tiWdHuRtU/k56ffoZGAnQ6nd/TtZIsy/bpoNx9HU3Q/bndOObduvja6XRO0VwQEXmA5PerPj8pt5L+pn93z1WP7v0waivpsdONBGgjj7nD1x00BmBjEMPwYIIYhgcTxDA8mCCG4cEEMQwPJohheDBBDMODCWIYHkwQw/BgghiGBxPEMNoUi9UN9FO6QWi9QWm9rytDnUGY3Z9Dz7k3oK7uoMWJn9e7O0rvObVx5/WOu37KZPdDgHyZQlgLYhgeTBDD8GCCGIYHE8QwPJgghuHBBDEMDyaIYXgwQQzDgwliGB5MEMPwYIIYhgcTxDA82MZx5TgFwGmuDsi3ADxUU8HRYdCdFU8E8KsApgH4hitvZuTABCmG7nf7GZJaqVcrO+nWnk+Q/LHu2wvgzwrU6gjJp0leJiJze/YOfpzkt0VE9xT+nwbPLSpMkPwsInm9llye8PVT9SB5NsmTRKRIPZGyTCO5Wwt6TvJ/7xGR92gVXJJ/ISK6C7wxABMkH9pifMl1XfoiIlrG+FlXoAY1VbnVz/3LPnJM7HptduPPXYU+aISwQXpgOXpYTXIR6mMJAG21hmEeyZsALK/4nKLHBBleji/mkKPbOp+P+viAmyxADkm0FrxJ4sG6WIO5wBXEySNHl/cBOCFvldyCaaW/XeB75pLcLK9/4LDl20YKa0EGy5GnWzWRg64eYB3oVG4RZpPU+uiXBD6fJDBB+rNURLQL8vYS7/FqjesiWnuwKMc6SbR2odGyLtYxrhsyQydwXBFMLWf8coPntEwr1AKYX/J99hZZDym4I8v9IrIMwKwSU8Ta3dIPvwPNMdXdD1Pc37Ug6U+bWoBtugXRp7OuKfynLmS54+sAbgTwxw2dkw5aNwWQ47sk79Up27xHQe4EsL/kOaskWwCsRHORCdcDeBDAf7v74Xu68Ommp9Mv4jk2NtZ9Qv66dmFI/kGflx4QkU8VqeXdWxC0gBz6FJ2NcujY4xKSX0X9Ld/fA1hQ8n1eFZE1AO5CDZCcSlLXb7SufL8u7ZiIfMJNJhxesKDsj9juLtb7Sd43oH9/AslbROSQezpWzQoAW0REw0jK8CKAjQDqlkPZSXLcdQ+1m1KU6Tomkddn0+qQ5Pf13EXEdz8uIKkPy6dEZG+yXSx9WgBY43lSTHz9DTnn94twMYCbA8jxCoBrAdyG5riH5HoAT5d8n+lu4K7Xpkr0frh8gBxdjiH5yRruh0YFeSfJc3J8y0naDet2m4Y5cnKRazmORTl0MHl1w3L0SnK1C3cJIclyVATJD5PU38FQiMgit76UpiBZlr3DBc0NjQpFckoFknTHHDqDVgadqboSwO1oD3ucJM8FkOQWF8oSHBH5rZwPJ30Q/QoSnsXS/IS8S8UnVnCuS5wcZbtVyuUtk6PLLtfdKrtYOcP1/6sInXlbztdnJE+u4Dwm/zDUz3F5v0FE5vTu7t3vyLlCviXAbBXclGiT6waDuFtbEpI6s1aGmSRvryAAc36Bmdfc91BMghRZ8BkPHHi4JdBAb1VNM2xl0anRdSR1hq0MswBsI7kY6dwPrV4orBuVQ3Mh5gXqVm1DPGzX/JQAkhyn3UmSdUYqN0YyggwxMF8sIpoDcXyAj7uiJbNVRSU5GECSrSQ1MSxpkhFkAItc4GGZxbMuOlulszqxopKsc6v9ZZirkxypS5KNQOux2K0sh4hNWKtrJoif7SSvCjC7Nc/FrVUyBdwGkhBkgByaz7EwkBy6aJYKO0iuC7CYOJ+kSqKRxMmRJdx6XOBajhByrElMjt4pYF0n+VnJ95nnJBl6RTwWohekDxcWyCHvt0KuA/KtSBcNcLxGo2VLvs8cJ0nVsVu1kiXYeixx3arSId+uWxXzgDzPivtGl5hUhlkudqupfJLgRC1IHznKhnrDZTOuL5KLEjG7SX48gCTTNTMxlRz3LKHWQ5OFNgVY59CFtGtGTI5eSTYG2BFyesOZicGIVpA+abJlV8h1bWDjiMrRGwUcsiW5FBGTJdB6XOSicsvGVpkcb5ZkI4D/CyRJtC1JlIJMkuw0O1CabIzhI1VKsiHvpneejSCiHJNkEbceKwJlArYhTbat3OMkeSaQJNFtcxqTIL0JH8sDyXGoRWmybWWPy0x8JlBm4lJERBs2jhtWjtdc67E00O4jdCvklYWsF9xjt1IKboe0m2TmAj7nlcxMvE1EdPOvbn2S9l2kCAXRJ71yoZOj6O6BvVyaJ9mpjTd7UXRzuizL8gqzk6S4lIE5ASTR2K37Gq7ElUQXS3+D4yQvdmmyx9UtR+rkSFm+26XvvhAgfVcjis8NEAdWKbG0IKeLyB8GSpO9rOU55I3RlWRAq7LDvWZTydlDfdDdQfIxtJgYBJEAQYdt330kNlF2uM0TNpXs7qokH0SLiaGLFYpY02Tb2vXaHijHvdWMiiBrRiQqt25RtrtCpWXTd1vLKAiyNvF8jqZF2e7Sd7WmS3KkLkhqabJtFWWHS98tu5jYOrLExxxHtvBPaQ2jTcibr+1OF5bS6mnbvKQoiO66t1pEtLZI0+cyEshbJSmbvtsaUhPkBRFZJSIWst5Qa5Jl2W4X36ZFRestXzai6yBD43LRtb7dGZPIP1ZwT9fD7vtecHnqKTHNrUXon6Ga2/ki8qNOp7NDRDSFYDoiJilBSP45AD1C8rJLQb1Xw78BfA3xozJ8wCUyLQ5ZIJNucTGV7m1qXawq0JD6d5G8jqTGb61uewTqIETkIldN+BMi0kj12FgwQfKhhUW3uidvrJJ8CMDnXLfKGIAJUgCSNwaoo94EWs3pehEJsdvkSGCCFGOBKyx6pM586KMqSH6EpLYgRosFmYIE0AIyWtI6JkFE5HcClZ0bGZoQJJXoT622Ghu1lS6rEKlz6rgJQcpuI9MWVHTNrY6JFMJAMhEpu6lde9dBOp2OrrAeEJEQ1Z4aQ0QeqkqQCrtZ/0uXWI54GReRrybbgojIoxonhYgh+V0R2a27cwxTnjrvUSF63jEVHn0LIvJ3AH6AhAU5JCKaQxBrQJu2GhsClC/rSxXSuUNj1b5A8mnE2629IflpXvcEPldE9iIiSD4M4GMA9iNSSH5LRLSo6f7YzhvAorrHsEfm8etkbGysN17nJF3ZJXm2HiJyfMtmh47RLW5E5Dsi8h+dTud+EXlcz7+7r1Rs9Fz7dwI4U7dTInmaiGQtm3SYQvJ5Efm2iOzrdDr3iciT3S7oggUharK2UBDDiIk4H4OGURMmiGF4MEEMw4MJYhgeTBDD8GCCGIYHE8QwPJgghuHBBDEMDyaIYXgwQQzDgwliGB5MEMPwYIIYhgcTxDA8mCCG4cEEMQwPJohheDBBDMODCWIYHkwQw/BgghiGBxPEMDyYIIbhwQQxDA8miGF4MEEMA/35f1KIzyvhZg/JAAAAAElFTkSuQmCC",
    pick: "data:image/png;base64,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",
    mirror: "data:image/png;base64,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",
    grid: "data:image/png;base64,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",
    dup: "data:image/png;base64,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",
    merge: "data:image/png;base64,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",
};

// 把一条修正记录载入内存。两种格式：
//   overlay：dataURL = 玩家笔迹的透明 PNG（不含原图像素），tf = [x,y,s] 原图层的移动/缩放
//   full（无 tf，原图未动）：dataURL = 笔迹合成图直接整幅落位
// 原图像素从不进库——file:// 环境下原图画布被跨域污染读不出来，渲染时由 composeFix 现场组合
BF.loadFix = function(row) {
    if (!row.dataURL) row.dataURL = BF.EMPTY_PNG();   // 纯位移修正（无笔迹）：1×1 透明占位
    BF._loadSeq = BF._loadSeq || {};   // 同 src 载入代数：再次载入后，旧条的迟到解码一律作废（不得覆盖新数据）
    const seq = BF._loadSeq[row.src] = (BF._loadSeq[row.src] || 0) + 1;
    let eraseImg = null;   // 擦除遮罩独立异步解码，解码完成后补进 store 并重画
    if (row.eraseURL) {
        eraseImg = new Image();
        eraseImg.onload = () => {
            if (BF._loadSeq[row.src] !== seq) return;   // 已被更新的载入取代：迟到解码作废
            const cur = BF.store.get(row.src);
            // 遮罩常晚于笔迹解码：晚到时必须补一次 refresh——更早的那次刷新发生在遮罩未解码时，
            // composeFix 因 complete=false 跳过擦除，缓存里是不带擦除的成品（不能因「对象已在」而早退）
            if (cur && cur.eraseURL === row.eraseURL) { cur.eraseImg = eraseImg; BF.refresh(row.src); }
        };
        eraseImg.src = row.eraseURL;
    }
    (row.pieces || []).forEach(pc => {   // 复制块遮罩/冻结笔迹解码（渲染链用）；晚到补刷，同 eraseImg 机制
        if (pc.maskURL && !pc.maskImg) {
            pc.maskImg = new Image();
            pc.maskImg.onload = () => { if (BF._loadSeq[row.src] !== seq) return; BF.refresh(row.src); };
            pc.maskImg.src = pc.maskURL;
        }
        if (pc.inkURL && !pc.inkImg) {
            pc.inkImg = new Image();
            pc.inkImg.onload = () => { if (BF._loadSeq[row.src] !== seq) return; BF.refresh(row.src); };
            pc.inkImg.src = pc.inkURL;
        }
    });
    const img = new Image();
    img.onload = () => {
        if (BF._loadSeq[row.src] !== seq) return;   // 已被更新的载入取代：迟到解码作废
        BF.store.set(row.src, {
            mode: row.tf ? "overlay" : "full",
            img, eraseImg, eraseURL: row.eraseURL, pieces: row.pieces, tf: row.tf, scale: row.scale, dataURL: row.dataURL,
            fileW: row.fileW || img.width, fileH: row.fileH || img.height, updatedAt: row.updatedAt,
        });
        BF.refresh(row.src);   // 清三层缓存并重绘侧栏——启动载入后无需再手动保存（Renderer 未就绪时 refresh 自动跳过缓存清理，首次渲染自然走钩子）
        if (document.getElementById("bfPicker")) BF.updateList(true);   // 面板开着时（导入场景）立即补上「已修正」徽标——store 是异步落位的，openPicker 同步重建时还没到
    };
    img.src = row.dataURL;
};

// 部件的有效修正：自身修正优先；否则若这套衣服有组修正，现拼一条纯位移修正——
// 同一套的不同部件可能在不同时机才刷出来，组修正保证晚出现的部件自动套上整体偏移
BF.fixFor = function(src) {
    const own = BF.store.get(src);
    if (own) return own;
    const t = BF.parseTags(src);
    const g = t.name && BF.groups.get(t.slot + "/" + t.name);
    if (!g) return null;
    const orig = BF.seen.get(src);
    if (!orig || !orig.complete || !orig.naturalWidth) return null;
    return { mode: "overlay", img: null, tf: [g.tf[0], g.tf[1], 1], scale: BF.MODEL_H / orig.naturalHeight,
             fileW: orig.naturalWidth, fileH: orig.naturalHeight, updatedAt: g.updatedAt };
};

// 现场合成送渲染器的最终图：原图（按 tf 移动/缩放）+ 笔迹层 → ×scale 重采样
// 期间只做 drawImage（污染画布允许显示、禁止读取，游戏渲染器只显示不读取，互不冲突）
BF.composeFix = function(src) {
    const fix = BF.fixFor(src);
    if (!fix) return document.createElement("canvas");   // 原图加载失败且无自身修正：空图兜底（渲染器需要画布）
    const file = document.createElement("canvas");
    file.width = fix.fileW; file.height = fix.fileH;
    const ctx = file.getContext("2d");
    ctx.imageSmoothingEnabled = false;   // 像素风：合成全程最近邻（与游戏重采样一致）
    const orig = BF.seen.get(src);
    if (fix.mode === "overlay") {
        if (orig && orig.complete && orig.naturalWidth && fix.tf) {
            ctx.drawImage(orig, fix.tf[0], fix.tf[1], fix.fileW * fix.tf[2], fix.fileH * fix.tf[2]);
        }
        if (fix.eraseImg && (fix.eraseImg.complete === undefined || fix.eraseImg.complete)) {
            ctx.globalCompositeOperation = "destination-out";   // 原图层的擦除遮罩：只抠原图
            ctx.drawImage(fix.eraseImg, 0, 0);
            ctx.globalCompositeOperation = "source-over";
        }
        if (fix.pieces && orig && orig.complete && orig.naturalWidth) {
            for (const pc of fix.pieces) {   // 复制块重演快照，画在移动后的位置
                const t = BF.renderPiece(pc, orig, fix.eraseImg, fix.img);
                ctx.drawImage(t, pc.x, pc.y, pc.w * (pc.s ?? 1), pc.h * (pc.s ?? 1));
            }
        }
        if (fix.img) ctx.drawImage(fix.img, 0, 0);
    } else {   // tf 置空 = 该文件被整层分割过：原图不再单独画，只由各部分配方拼回（原图/配件层分割后走这条路）
        if (fix.pieces && orig && orig.complete && orig.naturalWidth) {
            for (const pc of fix.pieces) {
                const t = BF.renderPiece(pc, orig, fix.eraseImg, fix.img);
                ctx.drawImage(t, pc.x, pc.y, pc.w * (pc.s ?? 1), pc.h * (pc.s ?? 1));
            }
        }
        if (fix.img) ctx.drawImage(fix.img, 0, 0);
    }
    return BF.rescale(file, fix.scale);
};

// 模拟渲染器的重采样：文件图 ×scale 拉到模型画布高（imageSmoothing 关闭 = 整数倍无损）
BF.rescale = function(canvas, scale) {
    const out = document.createElement("canvas");
    out.width = canvas.width * scale; out.height = canvas.height * scale;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
};

// 启动：读全表进内存（晚于游戏首屏也无妨，下次渲染自然生效）
if (typeof indexedDB !== "undefined") {
    BF.openDB().then(db => {
        BF.db = db;
        return Promise.all([
            new Promise(res => { const req = BF.tx("readonly").getAll(); req.onsuccess = () => res(req.result || []); req.onerror = () => res([]); }),
            new Promise(res => { const req = BF.txG("readonly").getAll(); req.onsuccess = () => res(req.result || []); req.onerror = () => res([]); }),
        ]);
    }).then(([rows, groups]) => {
        groups.forEach(g => BF.groups.set(g.id, g));
        rows.forEach(BF.loadFix);
        // 启动竞态兜底：模组脚本早于游戏首次渲染，onload 里的即时重绘若发生在游戏界面就绪前会被吞掉
        // （症状=重启后修正不自动上屏）。分三次补刷，幂等且开销可忽略——游戏就绪后必然有一轮落在正确时机
        [500, 2000, 6000].forEach(ms => setTimeout(() => BF.refresh(), ms));
    }).catch(e => console.warn("[BF] IndexedDB 不可用，修正仅本次会话有效", e));
}

/* ---------- 渲染器图片加载钩子 ----------
   1) 命中修正 → 现场合成后回传（成功回调必须回传原 src，渲染器快路径依赖它）；
      原图未加载完则挂 load/error 监听延后交付
   2) 未命中 → 原样直通，同时用原始 <img> 记录文件（选图面板数据源、合成时的原图来源） */
(function() {
    if (!window.Renderer || !Renderer.ImageLoader) { console.warn("[BF] Renderer 未就绪，图片加载钩子未安装！"); return; }
    const orig = Renderer.ImageLoader;
    Renderer.ImageLoader = {
        loadImage(src, layer, ok, err) {
            const fixable = typeof src === "string" && BF.PREFIXES.some(p => src.startsWith(p));
            if (fixable) {
                if (!BF.seen.has(src)) {
                    const img = new Image();
                    BF.seen.set(src, img);
                    img.src = src;
                }
                const t = BF.parseTags(src);
                if (BF.store.has(src) || (t.name && BF.groups.has(t.slot + "/" + t.name))) {   // 自身修正或组修正都接管
                    const deliver = () => ok(src, layer, BF.composeFix(src));
                    const o = BF.seen.get(src);
                    if (o.complete || o.naturalWidth > 0) deliver();   // naturalWidth>0 = 已加载；加载中/失败走监听
                    else {
                        o.addEventListener("load", deliver, { once: true });
                        o.addEventListener("error", deliver, { once: true });   // 原图 404 也交付（纯笔迹修正）
                    }
                    return;
                }
            }
            orig.loadImage(src, layer, (s, l, image) => {   // 直通交付时修正可能已落库（IndexedDB 晚于原图加载完成）：改走钩子取合成图——
                const t2 = BF.PREFIXES.some(p => src?.startsWith?.(p)) ? BF.parseTags(src) : null;   // 渲染器回调会把结果写进 ImageCaches（L32190），原图压住修正直到手动保存
                if (BF.store.has(src) || (t2?.name && BF.groups.has(t2.slot + "/" + t2.name))) Renderer.ImageLoader.loadImage(src, layer, ok, err);
                else ok(src, layer, image);
            }, err);
        }
    };
})();

// 清掉某张图的渲染器缓存并重绘侧栏（保存/还原/导入后调用）
// 关键：光删 ImageCaches 不够——侧栏模型实例常驻（Renderer.CanvasModelCaches），compile 原地复用
// layer 对象，layer.image+imageSrc===src 的快路径会在查 ImageCaches 之前直接跳过加载，
// 必须把匹配图层的 image/imageSrc 一并抹掉，渲染器才会重新走 loadImage（我们的钩子）
BF.purgeLayerCaches = function(src) {
    if (!window.Renderer || !Renderer.CanvasModelCaches) { console.warn("[BF] CanvasModelCaches 不存在，跳过图层缓存清理"); return; }
    // 渲染器画图层时：处理参数（滤镜/颜色）没变就直接用 layer.cachedImage（旧加工成品），
    // 不看 layer.image 是否已换新（源码 L32140）——所以 cachedImage/cachedProcessing 必须一起清
    const wipe = layer => {
        delete layer.image;
        delete layer.imageSrc;
        delete layer.cachedImage;
        delete layer.cachedProcessing;
        delete layer.mask;
        delete layer.cachedMaskSrc;
    };
    for (const modelName of Object.keys(Renderer.CanvasModelCaches)) {
        const slots = Renderer.CanvasModelCaches[modelName];
        for (const slot of Object.keys(slots)) {
            const model = slots[slot];
            if (!model || !Array.isArray(model.layerList)) continue;
            for (const layer of model.layerList) {
                if (src ? layer.imageSrc === src : (layer.image !== undefined || layer.imageSrc !== undefined || layer.cachedImage !== undefined || layer.cachedProcessing !== undefined)) {
                    wipe(layer);
                }
            }
        }
    }
};
BF.refresh = function(src) {
    if (window.Renderer) {
        if (src) { delete Renderer.ImageCaches[src]; delete Renderer.ImageErrors[src]; }
        else for (const k of Object.keys(Renderer.ImageCaches)) {   // 无参=全量重激活：渲染器取图先查 ImageCaches 再走钩子（源码 L32261），
            const t = BF.parseTags(k);                              // 启动竞态会让原图先落缓存——不删缓存，图层清了重画仍命中原图，修正永远不上屏
            if (BF.store.has(k) || (BF.PREFIXES.some(p => k.startsWith(p)) && t.name && BF.groups.has(t.slot + "/" + t.name))) {
                delete Renderer.ImageCaches[k]; delete Renderer.ImageErrors[k];
            }
        }
        BF.purgeLayerCaches(src);
    }
    try { Wikifier.wikifyEval("<<updatesidebarimg>>"); } catch (e) { /* 非游戏环境忽略 */ }
};

/* ---------- 侧栏入口按钮 ----------
   由 boot.json 的 TweeReplacerAddon 注入（twee/patch/story-caption.twee → StoryCaption），
   与「Mod管理器」入口同一机制；按钮点击调用 window.BF.openPicker() */

/* ---------- 选图面板 ---------- */
BF.pick = { q: "", slot: "", st: "", sort: "path" };   // 搜索/筛选/排序状态（面板关了也保留）

// 路径 → 段：img/clothes/<槽位>/<名称>/<部分>，img/face/、img/hair/ 等两段式没有名称段
BF.parseTags = function(src) {
    const seg = (src.startsWith("img/clothes/") ? src.slice(12) : src.startsWith("img/face/") ? src.slice(9) : src.startsWith("img/hair/") ? src.slice(4) : src).split("/");
    return seg.length >= 3 ? { slot: seg[0], name: seg[1], part: seg.slice(2) }
                           : { slot: seg[0], name: null, part: seg.slice(1) };
};
// 名称 → 中文名：setup.clothes[槽位] 里按 variable/name 找对象，中文补丁把译名放 cn_name_cap 字段；
BF.cnName = function(slot, name) {
    const list = setup?.clothes?.[slot.replace("-", "_")];
    const it = Array.isArray(list) && list.find(x => x.variable === name || x.name === name);
    return it?.cn_name_cap && /\p{Script=Han}/u.test(it.cn_name_cap) ? it.cn_name_cap : name;
};

BF.openPicker = function() {
    BF.closeAll();
    const slots = [...new Set([...BF.seen.keys()].map(src => BF.parseTags(src).slot))].sort();
    const panel = BF.h(`
        <div class="bfOverlay" id="bfPicker">
            <div class="bfTop">
                <b>美化修正</b>
                <input id="bfSearch" placeholder="搜索路径…" value="${BF.pick.q.replace(/"/g, "&quot;")}">
                <select id="bfSlot"><option value="">全部部位</option>${slots.map(s => `<option ${BF.pick.slot === s ? "selected" : ""}>${s}</option>`).join("")}</select>
                <select id="bfSt">
                    <option value="">全部状态</option>
                    <option value="fix" ${BF.pick.st === "fix" ? "selected" : ""}>已修正</option>
                    <option value="raw" ${BF.pick.st === "raw" ? "selected" : ""}>未修正</option>
                </select>
                <select id="bfSort">
                    <option value="path" ${BF.pick.sort === "path" ? "selected" : ""}>按路径</option>
                    <option value="time" ${BF.pick.sort === "time" ? "selected" : ""}>按修正时间</option>
                </select>
                <span class="bfSpacer"></span>
                <button class="bfBtn" id="bfDoExport">导出</button>
                <button class="bfBtn" id="bfDoImport">导入</button>
                <button class="bfBtn bfClose">关闭</button>
                <div class="needmeet">
                    <h3>美化修正 ${window.modSC2DataManager?.getModLoader()?.getModZip("美化修正")?.modInfo?.version ?? "未知版本"}</h3>
                    <div class="m-2">
                        <b class="gold">Needmeet 遇欲</b> 呈现
                    </div>
                </div>
            </div>
            <div class="bfShare" id="bfShare" hidden>
                <textarea id="bfShareText"></textarea>
                <div class="bfShareBtns">
                    <button class="bfBtn" id="bfCopyCode">复制修正码</button>
                    <button class="bfBtn" id="bfFileSave" title="把修正码存成 .txt 文件：码太长消息发不下时，用群文件/网盘传文件">存为文件</button>
                    <button class="bfBtn" id="bfApplyCode">应用导入</button>
                    <button class="bfBtn" id="bfFileLoad" title="从 .txt 修正码文件导入（配合「存为文件」使用）">从文件导入</button>
                    <input type="file" id="bfFileIn" accept=".txt,text/plain" hidden>
                    <button class="bfBtn" id="bfShareHide">收起</button>
                </div>
            </div>
            <div class="bfList" id="bfList"></div>
        </div>`);
    document.body.appendChild(panel);
    panel.querySelector(".bfClose").addEventListener("click", BF.closeAll);
    panel.querySelector("#bfSearch").addEventListener("input", e => { BF.pick.q = e.target.value; BF.updateList(); });
    panel.querySelector("#bfSlot").addEventListener("change", e => { BF.pick.slot = e.target.value; BF.updateList(); });
    panel.querySelector("#bfSt").addEventListener("change", e => { BF.pick.st = e.target.value; BF.updateList(); });
    panel.querySelector("#bfSort").addEventListener("change", e => { BF.pick.sort = e.target.value; BF.updateList(); });
    panel.querySelector("#bfDoExport").addEventListener("click", () => BF.showShare());
    panel.querySelector("#bfDoImport").addEventListener("click", BF.openShare);
    panel.querySelector("#bfShareHide").addEventListener("click", () => { panel.querySelector("#bfShare").hidden = true; });
    panel.querySelector("#bfCopyCode").addEventListener("click", BF.exportCode);
    panel.querySelector("#bfFileSave").addEventListener("click", () => {   // 码太长消息发不下：存成 .txt 走群文件/网盘传播
        const code = panel.querySelector("#bfShareText").value;
        if (!code) { BF.toast("修正码还没生成好"); return; }
        BF.saveBlob(new Blob([code], { type: "text/plain;charset=UTF-8" }), "BF修正码-" + new Date().toISOString().slice(0, 10) + ".txt");   // 走 BF.saveBlob：手机 webview 里自己造 <a download> 唤不起保存，交给游戏/壳的 saveAs
    });
    const fileIn = panel.querySelector("#bfFileIn");
    panel.querySelector("#bfFileLoad").addEventListener("click", () => fileIn.click());
    fileIn.addEventListener("change", () => {   // 选完文件直接读入生效（等同粘贴 + 应用导入）
        const f = fileIn.files[0];
        fileIn.value = "";
        if (f) f.text().then(t => BF.importCode(t));
    });
    panel.querySelector("#bfApplyCode").addEventListener("click", () => BF.importCode(panel.querySelector("#bfShareText").value));
    BF.updateList("restore");
};

// 渲染列表（搜索/筛选/排序变化时只重刷列表区）
// keep: true=保持当前滚动位置（还原等原地刷新），"restore"=回到上次离开的位置（重开面板），无参=回顶部（筛选变化）
BF.updateList = function(keep) {
    const panel = document.getElementById("bfPicker");
    if (!panel) return;
    let items = [...BF.seen.entries()].filter(([src, img]) => img.complete && img.naturalWidth > 0);
    if (BF.pick.q) items = items.filter(([src]) => src.includes(BF.pick.q));
    if (BF.pick.slot) items = items.filter(([src]) => BF.parseTags(src).slot === BF.pick.slot);
    if (BF.pick.st) items = items.filter(([src]) => BF.store.has(src) === (BF.pick.st === "fix"));
    items.sort((a, b) => BF.pick.sort === "time"
        ? (BF.store.get(b[0])?.updatedAt ?? 0) - (BF.store.get(a[0])?.updatedAt ?? 0) || a[0].localeCompare(b[0])
        : a[0].localeCompare(b[0]));
    const box = panel.querySelector("#bfList");
    const st = keep === true ? box.scrollTop : keep === "restore" ? (BF.pickScroll ?? 0) : 0;
    box.innerHTML = "";
    const addRow = ([src, img]) => {
        const t = BF.parseTags(src);
        const tags = [`<span class="bfTag">${t.slot}</span>`]
            .concat(t.name ? [`<span class="bfTag bfName">${BF.cnName(t.slot, t.name)}</span>`] : [])
            .concat(t.part.map(p => `<span class="bfTag">${p}</span>`)).join("");
        const fixed = BF.store.has(src);
        const el = BF.h(`
            <div class="bfItem" data-src="${src}" title="${src}">
                <img src="${img.src}">
                <div class="bfItemText">
                    <div class="bfItemTags">${tags}</div>
                    <div class="bfItemPath">${src}</div>
                    ${fixed ? '<span class="bfBadge">已修正</span>' : ""}
                </div>
                ${fixed ? '<button class="bfBtn bfRestore">还原</button>' : ""}
            </div>`);
        el.addEventListener("click", () => BF.openEditor(src));
        el.querySelector(".bfRestore")?.addEventListener("click", e => {
            e.stopPropagation();
            BF.restoreFix(src);
            BF.updateList(true);
        });
        box.appendChild(el);
    };
    // 同一套衣服（槽位+名称相同）归为一组，组头带 导出/还原/组合编辑；无名称段的（face 两段式）独立成组
    const groups = new Map();
    items.forEach(it => {
        const t = BF.parseTags(it[0]);
        const key = t.name ? t.slot + "/" + t.name : it[0];
        if (!groups.has(key)) groups.set(key, { t, rows: [] });
        groups.get(key).rows.push(it);
    });
    for (const g of groups.values()) {
        const multi = g.rows.length > 1;
        const gid = g.t.name ? g.t.slot + "/" + g.t.name : null;
        const head = BF.h(`<div class="bfGroupHead">
            <span class="bfName">${g.t.name ? BF.cnName(g.t.slot, g.t.name) : g.t.part.join("/") || g.t.slot}</span>
            ${multi ? `<span class="bfTag">${g.rows.length} 个部件</span>` : ""}
            ${(gid && BF.groups.has(gid)) || g.rows.some(r => BF.store.has(r[0])) ? '<span class="bfBadge">已修正</span>' : ""}
            <span class="bfSpacer"></span>
             ${g.rows.some(r => BF.store.has(r[0])) ? '<button class="bfBtn bfGRestore" title="清除这套的全部修正">还原</button>' : ""}
            <button class="bfBtn bfGExport" title="只导出这套的修正码">导出</button>
            <button class="bfBtn bfGGroup" title="多部件整体移动编辑">编辑服装组合</button>
        </div>`);
        const srcs = g.rows.map(r => r[0]).sort();
        head.querySelector(".bfGExport").addEventListener("click", () => BF.exportGroup(gid, srcs));
        head.querySelector(".bfGRestore")?.addEventListener("click", () => BF.confirm(`清除「${g.name || gid}」这套的全部修正？`, () => {
            if (gid && BF.groups.has(gid)) { BF.groups.delete(gid); BF.eraseGroup(gid); }
            srcs.forEach(s => BF.restoreFix(s));
            BF.refresh();   // 靠组修正位移、无自身修正的部件也要重画
            BF.updateList(true);
        }));
        head.querySelector(".bfGGroup")?.addEventListener("click", () => BF.openGroup(srcs));
        box.appendChild(head);
        g.rows.forEach(addRow);
    }
    if (!items.length) box.innerHTML = '<div class="bfEmpty">暂无可修正的图像——先在游戏里穿上衣服，再回到这里。</div>';
    box.scrollTop = st;
};
BF.openShare = function() {   // 导入：展开码区待粘贴（默认收起）
    document.querySelector("#bfPicker #bfShare").hidden = false;
    const text = document.querySelector("#bfPicker #bfShareText");
    text.value = "";
    text.placeholder = "把收到的修正码粘贴到这里再点「应用导入」；码以文件传来的点「从文件导入」";
    text.focus();
};
// rows 不传 = 导出全部；传 srcs 对应的行 = 只导出这一套
BF.showShare = function(rows) {
    if (rows === undefined) rows = [
        ...[...BF.store.entries()].map(([src, v]) => BF.rowPlain(src, v)),
        ...[...BF.groups.values()].map(g => ({ src: "group:" + g.id, tf: g.tf, updatedAt: g.updatedAt })),   // 组修正行
    ];
    const share = document.querySelector("#bfPicker #bfShare");
    const text = document.querySelector("#bfPicker #bfShareText");
    share.hidden = false;
    text.value = "";
    if (rows.length) {
        text.placeholder = "正在生成修正码…";
        BF.encCode(rows).then(code => { text.value = code; text.placeholder = "修正码在下方（Ctrl+A 全选复制）"; })
            .catch(() => { text.placeholder = "生成修正码失败：浏览器过旧，缺少压缩流支持"; });
    } else {
        text.placeholder = "还没有任何修正可导出";
    }
    text.focus();
};
// 只导出某一套（组）的修正码：部件行 + 该套的组修正行
BF.exportGroup = function(gid, srcs) {
    const rows = srcs.map(src => { const v = BF.store.get(src); return v ? BF.rowPlain(src, v) : null; }).filter(Boolean);
    const gf = gid && BF.groups.get(gid);
    if (gf) rows.push({ src: "group:" + gid, tf: gf.tf, updatedAt: gf.updatedAt });
    if (!rows.length) { BF.toast("这套还没有修正，无可导出"); return; }
    BF.showShare(rows);
};
BF.closeAll = function() {
    const list = document.querySelector("#bfPicker #bfList");
    if (list) BF.pickScroll = list.scrollTop;   // 记住列表位置，重开面板时回到原处
    document.querySelectorAll(".bfOverlay").forEach(e => e.remove());
    // 关闭页面即全部重新激活：修正偶发没自动上屏时，关一次面板就能救回来（分两次补刷，幂等开销可忽略）
    [300, 1200].forEach(ms => setTimeout(() => BF.refresh(), ms));
};

/* ---------- 编辑器 ---------- */
BF.ed = null;   // 当前编辑会话 { src, fileW, fileH, scale, frames, layers[], active, view{x,y,z}, undo[], redo[] }

BF.openEditor = function(src) {
    const img = BF.seen.get(src);
    if (!img || !img.complete || !img.naturalWidth) { BF.toast("原图还没加载好，稍后再试"); return; }
    BF.closeAll();

    const fileW = img.naturalWidth, fileH = img.naturalHeight;
    const scale = BF.MODEL_H / fileH;
    const frames = Number.isInteger(fileW / fileH) ? fileW / fileH : 1;

    // 图层 0 = 原图（只显示与移动/缩放，noExport：导出不含原图像素），上层为透明编辑层
    // 污染原理：file:// 下原图画布读不出像素，导出只含玩家笔迹（永不污染），渲染时由 composeFix 现场组合
    const mkLayer = (name) => {
        const canvas = document.createElement("canvas");
        canvas.width = fileW; canvas.height = fileH;
        return { canvas, ctx: canvas.getContext("2d"), name, visible: true, x: 0, y: 0, s: 1 };
    };
    const base = mkLayer("原图");
    base.ctx.drawImage(img, 0, 0);
    base.locked = true;    // 原图层不可删除
    base.noExport = true;  // 原图层不参与导出（composeFix 渲染时按 tf 现场拼回）

    // 回填已保存的修正：原图层恢复移动/缩放，笔迹恢复成第一个编辑图层，擦除遮罩抠掉原图预览
    const layers = [base];
    const saved = BF.store.get(src);
    const erase = document.createElement("canvas");
    erase.width = fileW; erase.height = fileH;
    const eraseCtx = erase.getContext("2d");
    if (saved && (saved.tf || saved.pieces?.length)) {   // tf 置空也可能是「整层分割过」（这时 pieces 才是全部内容），同样要回填
        base.x = saved.tf?.[0] ?? 0;
        base.y = saved.tf?.[1] ?? 0;
        base.s = saved.tf?.[2] ?? 1;
        base.visible = saved.tf != null;   // tf 置空 = 上次保存时原图层被隐藏（原图层已分割），重开时保持隐藏
        if (saved.eraseImg && (saved.eraseImg.complete === undefined || saved.eraseImg.complete)) eraseCtx.drawImage(saved.eraseImg, 0, 0);
        for (const pc of saved.pieces ?? []) {   // 复制块回填（先于笔迹层，与渲染顺序一致）：重演快照
            const c = BF.renderPiece(pc, img, saved.eraseImg, saved.img);
            const PL = { canvas: c, ctx: c.getContext("2d"), name: pc.name || "复制块", visible: true,
                         x: pc.x, y: pc.y, s: pc.s ?? 1, noExport: true, piece: pc, crop: pc.crop ? { ...pc.crop } : undefined, pmDirty: false };   // 重开时不算脏：没真改遮罩就不重导出，避免异步未完成时导出空遮罩把块的擦除覆盖掉
            if (pc.maskURL) {   // 块遮罩重建为可继续编辑的画布：已解码就同步回填（保存立即带上），未解码才异步晚到补画
                const pm = document.createElement("canvas"); pm.width = c.width; pm.height = c.height;
                const mc = pm.getContext("2d");
                if (pc.maskImg && (pc.maskImg.complete === undefined || pc.maskImg.complete)) mc.drawImage(pc.maskImg, 0, 0);
                else {
                    const mi = new Image();
                    mi.onload = () => { mc.drawImage(mi, 0, 0); BF.redrawPiece(PL); };
                    mi.src = pc.maskURL;
                    pc.maskImg = mi;
                }
                pc.maskCanvas = pm;
            }
            layers.push(PL);
        }
        const restored = mkLayer("已保存笔迹");
        if (saved.img && (saved.img.complete === undefined || saved.img.complete)) {
            restored.ctx.drawImage(saved.img, 0, 0);
            layers.push(restored);
        }
    }

    base._etf = { x: base.x, y: base.y, s: base.s };   // 擦除遮罩当前所处的空间（=存档时的 tf）：applyLayer 靠它算「原图层动了多少」，首帧就得有基准
    BF.ed = { src, fileW, fileH, scale, frames, layers, active: 0, group: [], groupMove: false,
              view: { x: 0, y: 0, z: 0 }, undo: [], redo: [], erase, eraseCtx, eraseDirty: false,
              tool: "marquee", color: "#000", size: 1, alpha: 1, hideClothes: true, grid: true, bgAlpha: 0.4, fgAlpha: 1,   // 默认藏起服装便于对齐；网格默认开（对齐参考）
              mirror: { on: false, mode: "copy", x: fileW / 2 } };   // 镜像：对称轴位置（合成坐标）/ flip 翻转·copy 同像
    if (saved?.eraseImg) BF.redrawBase();   // 把已有擦除应用到原图层预览

    const panel = BF.h(`
        <div class="bfOverlay" id="bfEditor">
            <div class="bfTop">
                <button class="bfBtn" id="bfBack">‹ 返回</button>
                <b class="bfTitle">${BF.shortName(src)}</b>
                <span class="bfSpacer"></span>
                <div>
                    <button class="bfBtn" id="bfUndo" title="撤销"><img class="bfIco" src="${BF.ICONS.undo}" alt="撤销"></button>
                    <button class="bfBtn" id="bfRedo" title="重做"><img class="bfIco" src="${BF.ICONS.redo}" alt="重做"></button>
                </div>
                <button class="bfBtn" id="bfRestore">还原</button>
                <button class="bfBtn bfPrimary" id="bfSave">保存并生效</button>
                <button class="bfBtn bfClose">关闭</button>
            </div>
            <div class="bfMain">
                <div class="bfView" id="bfView">
                    <div class="bfChecker"></div><canvas class="bfStage" id="bfStage"></canvas>
                    <div class="bfMoreWrap" id="bfMoreWrap">
                        <button class="bfBtn" id="bfMore" title="更多工具">⋯</button>
                        <div class="bfMoreMenu bfHide" id="bfMoreMenu">
                            <button class="bfBtn" id="bfMirrorToggle"><img class="bfIco" src="${BF.ICONS.mirror}" alt="复像"><span>启用复像</span></button>
                            <button class="bfBtn bfActive" id="bfGridToggle"><img class="bfIco" src="${BF.ICONS.grid}" alt="网格"><span>隐藏网格</span></button>
                            <button class="bfBtn bfTool" id="bfDupLayer" title="复制当前选中的图层（笔迹层/复制块），副本出现在原层上方"><img class="bfIco" src="${BF.ICONS.dup}" alt="复制">复制图层</button>
                            <button class="bfBtn bfTool" id="bfMergeLayer" title="将当前图层与下一图层（图层条右侧相邻层）合并为一个块"><img class="bfIco" src="${BF.ICONS.merge}" alt="合并">合并图层</button>
                            <button class="bfBtn bfTool" data-tool="split" title="分割：在当前图层上划一条直线，行进方向右侧的部分分离成新图层（笔迹层直接分；复制块按遮罩分；原图层则拆成两张互补的原图配方）；按住 Shift 拖动可吸附到 0/45/90 度并落在整像素上"><img class="bfIco" src="${BF.ICONS.split}" alt="分割">分割图层</button>
                        </div>
                    </div>
                    <div class="bfControls">
                        <div class="bfPanel bfHide" id="bfPanel">
                            <button class="bfBtn bfActive" id="bfMirrorOn">关闭复像</button>
                            <button class="bfBtn" id="bfMirrorMode" title="镜像：以线为轴逐像素左右翻折；同像：线两侧互相同步平移复制（朝向不变，左边界有源线标记）">镜像</button>
                            <label><span>线</span> <input type="range" id="bfMirrorX" min="0" max="1000" value="500"><span class="bfVal" id="bfMirrorV"></span></label>
                        </div>
                        <div class="bfHide" id="bfScaleBox">
                            <label><input type="range" id="bfLayerScale" min="25" max="400" step="1" value="100" title="自由缩放（25%~400%）；整数倍最锐利，非整数倍会让像素边界落在半格上"><span class="bfVal" id="bfScaleV2">100%</span></label>
                            <div class="bfRow">
                                <button class="bfBtn bfBtnmod" id="bfSclM" title="跳到上一个对齐档（25/50/100/200/400%）：整倍缩放保证与网格完全对齐">&lt;&lt;</button><button class="bfBtn bfBtnmod" id="bfSclP" title="跳到下一个对齐档（25/50/100/200/400%）：整倍缩放保证与网格完全对齐">&gt;&gt;</button>
                                <button class="bfBtn bfBtnmod bfPrimary" id="bfScaleOk" title="确认：位置取整到纹素边界；笔迹层会把当前缩放定格成像素">✓</button>
                                <button class="bfBtn bfBtnmod" id="bfScaleNo" title="取消：恢复进入调节前的状态">✕</button>
                            </div>
                            <div class="bfVal bfHide" id="bfScaleTag"></div>
                        </div>
                        <div class="bfPanel bfHide" id="bfSplitBox">
                            <button class="bfBtn" id="bfSplitNo" title="取消切割：退出分割模式">取消切割</button>
                            <button class="bfBtn" id="bfSplitAll" title="开/关：这条线切全部图层，每层各生成两半（原来那几张不再保留）">全图切割</button>
                            <span>在图层上划一条直线，行进方向右侧分离为新图层</span>
                        </div>
                    </div>
                    <div class="bfLayers" id="bfLayers"></div>
                </div>
                <div class="bfSide">
                    <div class="bfRow bfTools">
                        <button class="bfBtn bfTool" data-tool="marquee" title="拖拽框选原图的一块区域，松手即复制成可移动的补块图层"><img class="bfIco" src="${BF.ICONS.marquee}" alt="框选"></button>
                        <button class="bfBtn bfTool" data-tool="move" title="移动"><img class="bfIco" src="${BF.ICONS.move}" alt="移动"></button>
                        <button class="bfBtn bfTool" data-tool="brush" title="画笔"><img class="bfIco" src="${BF.ICONS.brush}" alt="画笔"></button>
                        <button class="bfBtn bfTool" data-tool="eraser" title="橡皮"><img class="bfIco" src="${BF.ICONS.eraser}" alt="橡皮"></button>
                        <button class="bfBtn bfTool" id="bfScaleBtn" title="图层缩放：打开左上角缩放控制器（滑杆 / 对齐档 / 确认取消），并在画布上拖四角手柄缩放；调节中点击下方图层条里的图层可加入/移出缩放列表（整表一起缩放/移动）"><img class="bfIco" src="${BF.ICONS.scale}" alt="缩放"></button>
                        <button class="bfBtn bfHide" id="bfGroupMove" title="开/关：移动与撤销是否作用于全部图层（含组合部件）"><img class="bfIco" src="${BF.ICONS.group}" alt="组合"></button>
                    </div>
                    <div class="bfRow">
                        <label><span>颜色</span> <input type="color" id="bfColor" value="${BF.ed.color}" title="画笔颜色"><button class="bfBtn bfTool bfBtnmod" id="bfPick" title="取色工具：点一下开启，再在画布上点一下——取画面上看得到的那块像素（所有图层叠加后的最前可见内容，跟选中哪个图层无关，一律做成色块）盖到笔下，全堆进同一个「取色涂」图层；再点本按钮退出。手机 webview 取不到色，改贴色块；编辑器内按 Alt 同效"><img class="bfIco" src="${BF.ICONS.pick}" alt="取色工具"></button></label>
                        <label><span>粗细</span> <input type="range" id="bfSize" min="1" max="32" value="${BF.ed.size}"><span class="bfVal" id="bfSizeV">${BF.ed.size}</span></label>
                        <label><span>浓度</span> <input type="range" id="bfAlpha" min="10" max="100" value="100"><span class="bfVal" id="bfAlphaV">100%</span></label>
                    </div>
                    <div class="bfRow bfPos">
                        <span>X</span>
                        <button class="bfBtn bfBtnmod" id="bfLXm" title="左移一个像素">−</button><button class="bfBtn bfBtnmod" id="bfLXp" title="右移一个像素">＋</button>
                        <span class="bfVal" id="bfLXV">0</span>
                        <span>Y</span>
                        <button class="bfBtn bfBtnmod" id="bfLYm" title="上移一个像素">−</button><button class="bfBtn bfBtnmod" id="bfLYp" title="下移一个像素">＋</button>
                        <span class="bfVal" id="bfLYV">0</span>
                    </div>
                    <div class="bfRow">
                        <button class="bfBtn" id="bfZoomOut">－</button>
                        <button class="bfBtn" id="bfZoomIn">＋</button>
                        <button class="bfBtn" id="bfZoomFit">适应窗口</button>
                        <button class="bfBtn" id="bfSnap">刷新人物背景</button>
                        <button class="bfBtn bfActive" id="bfHideClothes" title="重画背景：藏起穿在身上的服装与饰品，便于对齐正在编辑的衣物">显示服装</button>
                        <label><span>人物背景</span> <input type="range" id="bfBgAlpha" min="0" max="100" value="40" title="人物背景透明度"><span class="bfVal" id="bfBgAlphaV">40%</span></label>
                        <label><span>服装前景</span> <input type="range" id="bfFgAlpha" min="0" max="100" value="100" title="正在编辑的服装整体透明度"><span class="bfVal" id="bfFgAlphaV">100%</span></label>
                        <label><span>棋盘明度</span> <input type="range" id="bfBgBright" min="50" max="150" value="100" title="编辑器棋盘格底纹的明暗（只影响显示，不进导出数据）"><span class="bfVal" id="bfBgBrightV">100%</span></label>

                    </div>
                    <div class="bfRow">
                        <button class="bfBtn" id="bfLayerExport" title="导出选中图层：游戏原图（原图层/复制块/配件层）走 ModLoader 接口取字节后存成 PNG（手机端也能弹保存框）；纯笔迹层/导入的图则存成 PNG（透明底、位置已对齐）">导出图层</button>
                        <button class="bfBtn" id="bfLayerImport" title="把一张 PNG 导入成新图层（按文件尺寸铺开，位置天然对齐；导入后可直接拖动/缩放）">导入图层</button>
                        <input type="file" id="bfLayerIn" accept="image/*" hidden>
                    </div>
                    <div class="bfTip">双指/滚轮缩放 · 中键平移 · 移动工具拖动选中图层 · 双击图层名可重命名 · 框选松手后可选复制或删除 · 组合模式下移动作用于全部图层</div>
                </div>
            </div>
        </div>`);
    document.body.appendChild(panel);
    BF.ed.panel = panel;
    BF.ed.stage = panel.querySelector("#bfStage");
    BF.ed.viewEl = panel.querySelector("#bfView");

    const leave = cb => {   // 退出/返回前先问一句：本次打开后有改动还没保存
        if (BF.ed.dirty) BF.confirm("这次打开后有改动还没保存，仍要退出？", cb);
        else cb();
    };
    panel.querySelector("#bfBack").addEventListener("click", () => leave(() => { document.removeEventListener("keydown", BF.ed._keyH); document.removeEventListener("keyup", BF.ed._keyH); BF.ed = null; BF.openPicker(); }));
    panel.querySelector(".bfClose").addEventListener("click", () => leave(() => { document.removeEventListener("keydown", BF.ed._keyH); document.removeEventListener("keyup", BF.ed._keyH); BF.ed = null; BF.closeAll(); }));
    panel.querySelector("#bfUndo").addEventListener("click", BF.undo);
    panel.querySelector("#bfRedo").addEventListener("click", BF.redo);
    panel.querySelector("#bfSave").addEventListener("click", BF.saveFix);
    panel.querySelector("#bfRestore").addEventListener("click", () => {   // 组合编辑激活配件时还原该配件，否则还原主文件
        const s = BF.ed.layers[BF.ed.active].gSrc || src;
        BF.confirm(`把「${BF.shortName(s)}」还原为原版？该文件的修正会被清除。`, () => BF.restoreFix(s));
    });
    panel.querySelectorAll(".bfTool").forEach(b => b.addEventListener("click", () => { BF.ed.tool = b.dataset.tool; BF.syncTools(); moreMenu.classList.add("bfHide"); }));
    panel.querySelector("#bfGroupMove").addEventListener("click", e => {
        BF.ed.groupMove = !BF.ed.groupMove;
        e.currentTarget.classList.toggle("bfActive", BF.ed.groupMove);
    });
    panel.querySelector("#bfColor").addEventListener("input", e => BF.ed.color = e.target.value);
    // 取色块：手机 webview 没有系统吸管、画布又被原图污染读不了像素 —— 改为在画布上点一下取「全图层所见像素」，
    // 一律做成色块盖到笔下（不看选中图层，笔迹也一样成块）。
    // ed.pickSrc：undefined=关；null=已开启待取；有值=已取好样板，之后每次点画布盖一块，全部堆进同一个图层
    const pick = on => {   // 开/关取色块：开时颜色选择器禁用、其他工具灰掉（同缩放工具），蓝框等取样后出现
        const ed = BF.ed;
        if (on && ed._scaleMode) scaleUI(false);   // 与缩放模式互斥：开取色块先退出缩放
        ed.pickSrc = on ? null : undefined;
        panel.querySelector("#bfPick").classList.toggle("bfActive", on);
        panel.querySelector("#bfColor").disabled = on;   // 涂的是色块，画笔颜色用不上
        BF.syncTools();
        BF.renderStage();
        BF.toast(on ? "工具：先在画布上点一下采集色块，之后每次点画布盖一块" : "已退出取色工具");
    };
    panel.querySelector("#bfPick").addEventListener("click", e => { e.preventDefault(); pick(BF.ed.pickSrc === undefined); });   // preventDefault：挡掉 label 把点击转发给色块（否则点取色会连带弹出系统调色板）
    BF.ed._keyH = e => {   // Alt = 按住式临时取色：按住时首次点画布取色块、之后每次点盖一块，松开 Alt 即关闭；preventDefault 拦掉浏览器菜单栏聚焦
        if (e.key !== "Alt") return;
        e.preventDefault();
        if (e.type === "keydown") { if (BF.ed.pickSrc === undefined) pick(true); }
        else pick(false);
    };
    document.addEventListener("keydown", BF.ed._keyH);
    document.addEventListener("keyup", BF.ed._keyH);
    panel.querySelector("#bfSize").addEventListener("input", e => {
        BF.ed.size = +e.target.value; panel.querySelector("#bfSizeV").textContent = e.target.value;
        if (BF.ed.pickSrc) { BF.ed.pickSrc = null; BF.renderStage(); BF.toast("采集粗细变化，请重新完成采集"); }   // 样板大小随粗细：改了就得重取（蓝框跟着消失）
    });
    panel.querySelector("#bfAlpha").addEventListener("input", e => { BF.ed.alpha = +e.target.value / 100; panel.querySelector("#bfAlphaV").textContent = e.target.value + "%"; });
    const nudge = (attr, dir) => {   // ±整像素微调（与松手吸附同一网格：合成画布整像素）
        BF.setLayer(attr, BF.ed.layers[BF.ed.active][attr] + dir);
    };
    panel.querySelector("#bfLXm").addEventListener("click", () => nudge("x", -1));
    panel.querySelector("#bfLXp").addEventListener("click", () => nudge("x", 1));
    panel.querySelector("#bfLYm").addEventListener("click", () => nudge("y", -1));
    panel.querySelector("#bfLYp").addEventListener("click", () => nudge("y", 1));
    panel.querySelector("#bfLayerScale").addEventListener("input", e => BF.setLayer("s", +e.target.value / 100));
    const ALIGN_S = [0.25, 0.5, 1, 2, 4];   // 对齐档位（25%~400%）：整倍缩放时图层纹素边界全部落在网格线上（自由值仍可拖滑杆）
    const nudgeS = up => {   // ± 跳最近对齐档：缩放对齐网格用
        const cur = BF.ed.layers[BF.ed.active].s;
        const s = up ? ALIGN_S.find(x => x > cur + 1e-9) : [...ALIGN_S].reverse().find(x => x < cur - 1e-9);
        if (s) BF.setLayer("s", s);
    };
    panel.querySelector("#bfSclM").addEventListener("click", () => nudgeS(false));
    panel.querySelector("#bfSclP").addEventListener("click", () => nudgeS(true));
    const precise = (vId, sId, toSlider) => {   // 点滑杆旁的数值弹框精确输入：范围校验通过才写回滑杆并触发 input（复用既有联动）
        const sp = panel.querySelector(vId), el = panel.querySelector(sId);
        const fmt = toSlider ? "0 ~ " + BF.ed.fileW + "px" : el.min + " ~ " + el.max;
        sp.title = "点击输入精确数值（" + fmt + "）";
        sp.style.cursor = "pointer";
        sp.addEventListener("click", () => BF.prompt("精确输入（" + fmt + "）", sp.textContent, v => {
            const f = parseFloat(v);
            const n = isNaN(f) ? NaN : (toSlider ? Math.round(f / BF.ed.fileW * 1000) : Math.round(f));
            if (!(n >= +el.min && n <= +el.max)) { BF.toast("超出范围（" + fmt + "）"); return; }
            el.value = n;
            el.dispatchEvent(new Event("input"));
        }));
    };
    precise("#bfSizeV", "#bfSize");
    precise("#bfAlphaV", "#bfAlpha");
    precise("#bfMirrorV", "#bfMirrorX", true);   // 复像线显示的是像素，按像素输入反推滑杆值
    precise("#bfScaleV2", "#bfLayerScale");
    precise("#bfBgAlphaV", "#bfBgAlpha");
    precise("#bfFgAlphaV", "#bfFgAlpha");
    precise("#bfBgBrightV", "#bfBgBright");

    panel.querySelector("#bfSnap").addEventListener("click", BF.snapBackground);
    panel.querySelector("#bfHideClothes").addEventListener("click", e => {
        BF.ed.hideClothes = !BF.ed.hideClothes;
        e.currentTarget.textContent = BF.ed.hideClothes ? "显示服装" : "隐藏服装";
        e.currentTarget.classList.toggle("bfActive", BF.ed.hideClothes);
        BF.snapBackground();
    });
    const bga = panel.querySelector("#bfBgAlpha");
    bga.addEventListener("input", () => { BF.ed.bgAlpha = bga.value / 100; panel.querySelector("#bfBgAlphaV").textContent = bga.value + "%"; BF.renderStage(); });
    const fga = panel.querySelector("#bfFgAlpha");
    fga.addEventListener("input", () => { BF.ed.fgAlpha = fga.value / 100; panel.querySelector("#bfFgAlphaV").textContent = fga.value + "%"; BF.renderStage(); });
    const bgt = panel.querySelector("#bfBgBright");
    bgt.addEventListener("input", () => {   // 棋盘格底纹明暗：滤镜打底纹层上，不碰画布里的图像
        const v = bgt.value / 100;
        panel.querySelector(".bfChecker").style.filter = v === 1 ? "" : `brightness(${v})`;
        panel.querySelector("#bfBgBrightV").textContent = bgt.value + "%";
    });
    panel.querySelector("#bfZoomIn").addEventListener("click", () => BF.zoomBy(1.25));
    panel.querySelector("#bfZoomOut").addEventListener("click", () => BF.zoomBy(0.8));
    panel.querySelector("#bfZoomFit").addEventListener("click", BF.fitView);
    // 读游戏原图字节：src hook / XHR / fetch / mod 包里的 JSZip，全读不到就让桌面端新开页面看图
    BF.readGameImage = async function(src) {
        const hook = window.modSC2DataManager?.getHtmlTagSrcHook?.();
        if (typeof hook?.requestImageBySrc === "function") {   // 返回 data:image/png;base64,...；没这图就返回 undefined
            try {
                const dataURL = await hook.requestImageBySrc(src);
                if (typeof dataURL === "string" && dataURL.startsWith("data:")) return BF.dataURLToBlob(dataURL);
            } catch (e) { console.warn("[BF] requestImageBySrc 读原图失败", e); }
        }
        const url = new URL(src, document.baseURI).href;
        const b = await new Promise(res => {   // XHR 直读文件：手机 WebView 读本地资源的标准方式；桌面 Chrome 会走 onerror，超时也当失败
            try {
                const x = new XMLHttpRequest();
                x.open("GET", url); x.responseType = "blob"; x.timeout = 8000;
                x.onload = () => res((x.status === 200 || x.status === 0) && x.response && x.response.size ? x.response : null);
                x.onerror = x.ontimeout = () => res(null);
                x.send();
            } catch (e) { res(null); }
        });
        if (b) return b;
        try { const r = await fetch(url); if (r.ok) return await r.blob(); } catch (e) { }   // 页面若挂在内置服务器上（http/https），fetch 一次就中
        const ml = window.modSC2DataManager?.getModLoader?.();
        for (const m of (ml?.getModCacheArray?.() || []).concat(ml?.getModZip?.("GameOriginalImagePack"))) {   // 原图也可能装在某个 mod 包里：JSZip 和 ModPack 格式都提供 files[路径] 表
            const z = m?.zip || m?.mod?.zip || m;   // 缓存条目 / 条目里的读包器 / 读包器本体，三种形态都兜住
            try { const o = z?.getZipFile?.()?.files?.[src]; if (o?.async) return await o.async("blob"); } catch (e) { }   // 没这文件或包已被回收：看下一个
        }
        return null;
    };
    panel.querySelector("#bfLayerExport").addEventListener("click", async () => {   // 导出选中图层：画的是游戏原图就把原图文件存下来（字节直取，绕开画布污染）；自己画的/导入的才导画布
        const ed = BF.ed, L = ed.layers[ed.active];
        if (!L) return;
        const src = L.gSrc || (L === ed.layers[0] || L.piece ? ed.src : null);   // 配件层导它自己的部件原图，其余导当前文件的原图
        if (src) {
            const name = src.split("/").pop() || "原图.png";
            BF.toast("正在读取原图：" + name);
            let b = null;
            try { b = await BF.readGameImage(src); } catch (e) { console.warn("[BF] 读原图出错", e); }
            if (b) {
                if (await BF.saveBlob(b, name)) BF.toast("正在保存原图：" + name);
                else BF.toast("保存失败，请在电脑上取：" + name);
                return;
            }
            if (!/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) window.open(new URL(src, document.baseURI).href, "_blank");   // 桌面浏览器读不到时的兜底：新开一页显示原图，右键另存即可；手机上不新开，免得把游戏页顶掉
            BF.toast("读不到原图字节：" + name + "，请在电脑上取");
            return;
        }
        const c = document.createElement("canvas");   // 纯笔迹层/导入的图：画布干净可读，铺成整张文件尺寸导出，位置已对齐
        c.width = ed.fileW; c.height = ed.fileH;
        const cc = c.getContext("2d");
        cc.imageSmoothingEnabled = false;
        cc.drawImage(L.canvas, L.x, L.y, L.canvas.width * L.s, L.canvas.height * L.s);   // 与 renderStage 同一套画法，像素位置一致
        try { c.toBlob(b => b && BF.saveBlob(b, (L.name || "图层") + ".png"), "image/png"); }
        catch (err) { BF.toast("这层读不出像素，导不出来"); }
    });
    const layerIn = panel.querySelector("#bfLayerIn");
    panel.querySelector("#bfLayerImport").addEventListener("click", () => layerIn.click());
    layerIn.addEventListener("change", () => {
        const f = layerIn.files[0];
        layerIn.value = "";
        if (!f) return;
        // 不能再用 URL.createObjectURL：页面 CSP 是 img-src 'self' data:，blob: 会被拦下（报 CSP 违规且图读不出）。
        // 改读成 data: URL——同属白名单，且 data: 图片不污染画布，导入的图之后还能再导出、能进修正数据。
        const fr = new FileReader();
        fr.onerror = () => BF.toast("这个文件读不了，换一张 PNG 试试");
        fr.onload = () => {
            const img = new Image();
            img.onload = () => {
                const ed = BF.ed;
                if (!ed) return;
                const c = document.createElement("canvas");
                c.width = ed.fileW; c.height = ed.fileH;   // 铺满文件尺寸：和原图共用同一坐标系，位置天生对齐
                const cc = c.getContext("2d");
                cc.imageSmoothingEnabled = false;
                const k = Math.min(1, ed.fileW / img.naturalWidth, ed.fileH / img.naturalHeight);   // 图比画布大：等比缩小到放得下（不然超出部分被裁掉，画布看着是空的）
                const iw = Math.round(img.naturalWidth * k), ih = Math.round(img.naturalHeight * k);
                cc.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, iw, ih);
                const NL = { canvas: c, ctx: cc, name: f.name, visible: true, x: 0, y: 0, s: 1 };
                ed.layers.push(NL);
                ed.active = ed.layers.length - 1;
                BF.pushUndo([]).push({ L: NL, inList: false, x: 0, y: 0, s: 1 });   // 撤销 = 整层移除
                ed.tool = "move";
                BF.syncLayers(); BF.syncTools(); BF.applyLayer(NL);
                BF.toast("已导入图层：" + f.name + "（拖动/缩放摆位置）");
            };
            img.onerror = () => BF.toast("这张图读不了，换一张 PNG 试试");
            img.src = fr.result;
        };
        fr.readAsDataURL(f);
    });

    // 背景层（离屏画布，只显示用，不参与导出）+ 初始快照
    const bg = document.createElement("canvas");
    bg.width = fileW; bg.height = fileH;
    BF.ed.bg = bg;
    BF.snapBackground();

    BF.fitView();
    // 更多工具（左上角折叠菜单）+ 镜像面板（画布左上角固定，不占工具栏）。
    // 两者都在画布区内：pointerdown 必须拦下——否则 bindPointer 会抢占指针捕获，
    // click 被重定向到画布、按钮永远收不到，还会顺带触发一次画布工具操作
    const moreMenu = panel.querySelector("#bfMoreMenu");
    for (const sel of ["#bfMoreWrap", "#bfPanel", "#bfLayers", "#bfScaleBox", "#bfSplitBox"])
        panel.querySelector(sel).addEventListener("pointerdown", e => e.stopPropagation());
    // 滚轮统一在编辑器根节点以「捕获阶段」接管：捕获比游戏的冒泡式全局滚动监听更早触发，
    // 再 stopPropagation + preventDefault——游戏的背景滚动条既收不到事件、也无法执行默认滚动。
    // 图层条→横滚、工具面板→竖滚（手动滚，滚到底也不会链给页面），画布区→视图缩放，其余区域只吃掉
    panel.addEventListener("wheel", e => {
        e.stopPropagation();
        e.preventDefault();
        const ly = e.target.closest(".bfLayers"), sd = e.target.closest(".bfSide");
        if (ly) ly.scrollLeft += e.deltaX || e.deltaY;
        else if (sd) sd.scrollTop += e.deltaY;
        else if (e.target.closest(".bfView")) {
            const r = BF.ed.viewEl.getBoundingClientRect(), d = window.devicePixelRatio || 1;
            const cur = Math.round(BF.ed.view.z * d), f = e.deltaY < 0 ? 1.15 : 0.87;
            BF.zoomAt(e.clientX - r.left, e.clientY - r.top, (e.deltaY < 0 ? Math.max(cur + 1, Math.round(cur * f)) : Math.min(cur - 1, Math.round(cur * f))) / d);
        }
    }, { capture: true, passive: false });
    // 移动端工具区折叠（样式只在窄屏生效，桌面加了类也无影响）：面板已滚到顶再下滑 → 收起到 20% 高；
    // 收起后上滑 → 恢复。纯靠滑动方向判断，不加额外按钮
    const side = panel.querySelector(".bfSide");
    let sy = 0;
    side.addEventListener("touchstart", e => { sy = e.touches[0].clientY; }, { passive: true });
    side.addEventListener("touchmove", e => {
        const dy = e.touches[0].clientY - sy;
        if (side.classList.contains("bfCollapsed") ? dy < -24 : (side.scrollTop <= 0 && dy > 24)) side.classList.toggle("bfCollapsed");
    }, { passive: true });
    panel.querySelector("#bfMore").addEventListener("click", () => moreMenu.classList.toggle("bfHide"));
    BF.ed.viewEl.addEventListener("pointerdown", e => {   // 点画布其它地方收菜单
        if (!moreMenu.classList.contains("bfHide") && !e.target.closest("#bfMoreWrap")) moreMenu.classList.add("bfHide");
    });
    const mirrorUI = () => {
        const m = BF.ed.mirror;
        panel.querySelector("#bfMirrorToggle span").textContent = m.on ? "关闭复像" : "启用复像";
        panel.querySelector("#bfPanel").classList.toggle("bfHide", !m.on);
        panel.querySelector("#bfMirrorOn").textContent = m.on ? "关闭复像" : "启用复像";
        panel.querySelector("#bfMirrorOn").classList.toggle("bfActive", m.on);
        panel.querySelector("#bfMirrorMode").textContent = m.mode === "flip" ? "镜像" : "同像";
        panel.querySelector("#bfMirrorX").value = Math.round(m.x / BF.ed.fileW * 1000);
        BF.mirrorLine();
    };
    panel.querySelector("#bfMirrorToggle").addEventListener("click", () => { BF.ed.mirror.on = !BF.ed.mirror.on; moreMenu.classList.add("bfHide"); mirrorUI(); });
    panel.querySelector("#bfMirrorOn").addEventListener("click", () => { BF.ed.mirror.on = !BF.ed.mirror.on; mirrorUI(); });
    panel.querySelector("#bfMirrorMode").addEventListener("click", () => { BF.ed.mirror.mode = BF.ed.mirror.mode === "flip" ? "copy" : "flip"; mirrorUI(); });
    panel.querySelector("#bfMirrorX").addEventListener("input", e => { BF.ed.mirror.x = Math.round(+e.target.value / 1000 * BF.ed.fileW * 2) / 2; BF.mirrorLine(); });   // 吸附半像素：与镜像运算的取整精度一致
    panel.querySelector("#bfDupLayer").addEventListener("click", () => { BF.dupLayer(); moreMenu.classList.add("bfHide"); });
    panel.querySelector("#bfMergeLayer").addEventListener("click", () => { BF.mergeLayer(); moreMenu.classList.add("bfHide"); });
    panel.querySelector("#bfSplitNo").addEventListener("click", () => { BF.ed.tool = "move"; BF.syncTools(); });   // 取消切割：退出分割模式
    panel.querySelector("#bfSplitAll").addEventListener("click", e => { BF.ed.splitAll = !BF.ed.splitAll; e.currentTarget.classList.toggle("bfActive", BF.ed.splitAll); });   // 全图切割：这条线切全部图层
    panel.querySelector("#bfGridToggle").addEventListener("click", e => {
        BF.ed.grid = !BF.ed.grid;
        e.currentTarget.querySelector("span").textContent = BF.ed.grid ? "隐藏网格" : "显示网格";
        e.currentTarget.classList.toggle("bfActive", BF.ed.grid);
        BF.applyView();
    });
    mirrorUI();
    // 图层缩放模式：按钮开合调节条 + 画布金色调节框（右下角手柄可拖拽缩放），确认/取消收场。
    // 缩放中锁定为移动工具：其他工具按钮禁用、画布上非移动操作全部拒识（toolDown 统一拦截）
    const scaleUI = on => {
        const ed = BF.ed, L = ed.layers[ed.active];
        if (on && ed.pickSrc !== undefined) pick(false);   // 与取色块互斥：开缩放先退出取色块
        if (on) {
            L._s0 = { x: L.x, y: L.y, s: L.s, crop: L.crop ? { ...L.crop } : null };   // 取消用的进模快照（记在层上，中途换选中层也不串）
            ed._scaleSel = [L];   // 缩放列表：进模时含当前层，图层条里点其他层加入/再点移出（确认/取消/滑杆都作用于整表）
            if (!ed._tool0) ed._tool0 = ed.tool;   // 退出缩放时恢复进模前的工具
            ed.tool = "move";
        } else {
            if (ed._tool0) { ed.tool = ed._tool0; ed._tool0 = null; }
            ed._scaleSel = null;
        }
        ed._scaleMode = on;
        panel.querySelector("#bfScaleBox").classList.toggle("bfHide", !on);
        const st = panel.querySelector("#bfScaleTag");   // 「多选：n图层」标记：位于按钮行下方，仅多选（n>1）时显示
        st.textContent = "多选：" + (ed._scaleSel?.length ?? 0) + "图层";
        st.classList.toggle("bfHide", !(on && (ed._scaleSel?.length ?? 0) > 1));
        panel.querySelector("#bfScaleBtn").classList.toggle("bfActive", on);
        if (!on) ed.viewEl.style.cursor = "";
        BF.syncTools();
        BF.syncLayers();   // 退出缩放/清空多选列表后重建图层条：多选高亮立刻消失（syncLayers 内部会重画舞台）
    };
    panel.querySelector("#bfScaleBtn").addEventListener("click", () => scaleUI(!BF.ed._scaleMode));
    panel.querySelector("#bfScaleOk").addEventListener("click", () => { BF.scaleConfirm(); scaleUI(false); });
    panel.querySelector("#bfScaleNo").addEventListener("click", () => {
        for (const L of BF.ed._scaleSel ?? []) {   // 取消：缩放列表整表还原进模/入表时的快照
            const s0 = L._s0;
            if (s0) { L.x = s0.x; L.y = s0.y; L.s = s0.s; if (s0.crop) L.crop = { ...s0.crop }; else delete L.crop; BF.applyLayer(L); }
        }
        scaleUI(false);
    });
    BF.bindPointer();
    BF.syncLayers();
    BF.syncTools();
};

// 镜像/同像对称轴可视化：画进舞台画布（renderStage 内随视图一起绘制），这里只更新数值并触发重绘
BF.mirrorLine = function() {
    const ed = BF.ed;
    if (!ed?.stage) return;
    const v = ed.panel?.querySelector("#bfMirrorV");   // 线位置数值（px，半像素精度，与实际镜像运算同源）
    if (v) v.textContent = ed.mirror.x + "px";
    BF.renderStage();
};

// 组合编辑：以主文件开编辑器（优先 full.png），其余部件作为锁定参考层加入（各自按已保存 tf+笔迹合成入画），
// 「组合」开关默认开——移动/撤销作用于全部图层；保存时动过的部件各自写入修正记录（见 saveFix）
BF.openGroup = function(srcs) {
    srcs = srcs.slice().sort();
    const main = srcs.find(s => /\/full(-alt)?\.png$/.test(s)) ?? srcs[0];
    BF.openEditor(main);
    if (!BF.ed) return;
    srcs.filter(s => s !== main).forEach(src => {
        const img = BF.seen.get(src), fix = BF.store.get(src);
        if (!img || !img.complete || !img.naturalWidth) return;
        const eff = BF.fixFor(src);   // 自身修正优先，否则套组修正（组修正后新出现的部件也按整体偏移入场）
        const nm = BF.parseTags(src).part.join("/");   // 名字只存纯文本：「配件」金标改由 syncLayers 按 gSrc 渲染——否则它会跑进重命名框、还会被分割写进配方名
        if (fix?.pieces?.length) {   // 被分割过的部件：按配方重建两半（位置/缩放/裁剪都在配方里）
            for (const pc of fix.pieces) {
                const c = BF.renderPiece(pc, img, fix.eraseImg, fix.img);
                const PL = { canvas: c, ctx: c.getContext("2d"), name: pc.name?.replace(/<[^>]*>/g, "") || nm, visible: true, x: pc.x, y: pc.y, s: pc.s ?? 1,   // 兼容旧数据：老配方名里混进的「配件」金标剥掉
                             locked: true, noExport: true, gSrc: src, gScale: fix.scale, gData: fix.dataURL,
                             piece: pc, gInit: [pc.x, pc.y, pc.s ?? 1], crop: pc.crop ? { ...pc.crop } : undefined };
                BF.ed.layers.push(PL);
                BF.ed.group.push(PL);
            }
            return;
        }
        const L = { canvas: document.createElement("canvas"), name: nm,
                    visible: true, x: 0, y: 0, s: 1, locked: true, noExport: true,
                    gSrc: src, gScale: fix?.scale, gData: fix?.dataURL };
        L.canvas.width = img.naturalWidth; L.canvas.height = img.naturalHeight;
        L.ctx = L.canvas.getContext("2d");
        L.gInit = eff?.tf ? [...eff.tf] : [0, 0, 1];
        L.x = L.gInit[0]; L.y = L.gInit[1]; L.s = L.gInit[2];
        L.ctx.drawImage(img, 0, 0);   // 原图按自然位画入，位移由层位置体现（与主文件层同一语义）
        if (fix?.img && (fix.img.complete === undefined || fix.img.complete)) L.ctx.drawImage(fix.img, 0, 0);
        BF.ed.layers.push(L);
        BF.ed.group.push(L);
    });
    if (BF.ed.group.length) {
        BF.ed.groupMove = true;
        const btn = BF.ed.panel.querySelector("#bfGroupMove");
        btn.classList.remove("bfHide"); btn.classList.add("bfActive");
        BF.toast(`组合模式：${BF.ed.group.length + 1} 个部件一起移动`);
        BF.syncLayers();
    }
};

/* ---------- 舞台渲染：一切画进同一张设备分辨率画布 ---------- */
// 背景/图层/网格/镜像线/框选全部用 canvas 变换画进 #bfStage（画布尺寸 = 视口 × devicePixelRatio）。
// 不再用 CSS 定位 DOM 画布（left/top/transform）——部分内核的合成器会把画布元素位置吸附到
// 设备像素格点（奇数偏移落在半格上，如 left:-5px 在 150% 缩放下实际停在 -7 与 -8 设备像素之间），
// 网格与图像互相错位；单画布自绘从结构上免疫该问题（同一光栅化、同一原点、无合成器参与）
BF.renderStage = function() {   // 合帧入口：一次双指缩放/拖动会连触 2+ 次，排队到下一帧只画一次（手机跟手的关键）
    const ed = BF.ed;
    if (!ed?.stage || !ed.viewEl || !(ed.view.z > 0)) return;
    if (ed._rsQueued) return;
    ed._rsQueued = true;
    requestAnimationFrame(() => { ed._rsQueued = false; BF.drawStage(); });
};
BF.drawStage = function() {   // 实际绘制，每帧最多一次（排队期间编辑器可能已关闭/重建，故重查守卫）
    const ed = BF.ed;
    if (!ed?.stage || !ed.viewEl || !(ed.view.z > 0)) return;
    const v = ed.view, d = window.devicePixelRatio || 1;
    const vw = ed.viewEl.clientWidth, vh = ed.viewEl.clientHeight;
    const st = ed.stage;
    const W = Math.max(1, Math.round(vw * d)), H = Math.max(1, Math.round(vh * d));
    if (st.width !== W || st.height !== H) { st.width = W; st.height = H; st.style.width = vw + "px"; st.style.height = vh + "px"; }
    const ctx = st.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    // 背景与图层：同一套 canvas 变换（v.x/v.y 是视口 CSS px，×d 转设备像素；量化后均为整数设备像素）
    ctx.setTransform(v.z * d, 0, 0, v.z * d, v.x * d, v.y * d);
    ctx.globalAlpha = ed.bgAlpha ?? 0.4;
    ctx.drawImage(ed.bg, 0, 0);
    for (const L of ed.layers) {
        if (!L.visible) continue;
        ctx.globalAlpha = ed.fgAlpha ?? 1;   // 服装前景整体透明度：调淡后可透视背景对齐
        const cp = L.crop;   // 手动裁剪调节中：只画裁剪框内，框外不显示
        if (cp) ctx.drawImage(L.canvas, cp.l, cp.t, L.canvas.width - cp.l - cp.r, L.canvas.height - cp.t - cp.b,
                              L.x + cp.l * L.s, L.y + cp.t * L.s, (L.canvas.width - cp.l - cp.r) * L.s, (L.canvas.height - cp.t - cp.b) * L.s);
        else ctx.drawImage(L.canvas, L.x, L.y, L.canvas.width * L.s, L.canvas.height * L.s);
    }
    ctx.globalAlpha = 1;
    // 网格/镜像线/框选：纹素坐标换算到设备像素后直接画，与图层同一原点、同一光栅化——严格同格
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const s = v.z * d, ox = v.x * d, oy = v.y * d;   // 静止时为整数设备像素；双指缩放跟手中可为小数（松手吸附）
    if (ed.grid) {   // 格线只画在纹素边界上；屏上一格不足 ~4 CSS px 时自动改画每 step 纹素一条——
        const step = Math.max(1, Math.ceil(4 * d / s));   // 否则 1px 线挤进 2~3 设备像素间距会和图像干涉成摩尔纹；放大后自动回到逐纹素
        const sp = s * step;
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        for (let x = ((ox % sp) + sp) % sp; x < W; x += sp) ctx.fillRect(Math.round(x), 0, 1, H);   // 线位取整：跟手阶段也保持 1px 锐利、不闪
        for (let y = ((oy % sp) + sp) % sp; y < H; y += sp) ctx.fillRect(0, Math.round(y), W, 1);
    }
    if (ed.mirror?.on) {
        ctx.fillStyle = "rgba(80,200,255,0.9)";
        ctx.fillRect(Math.round(ox + ed.mirror.x * s), 0, 1, H);   // 对称轴（半像素轴四舍五入到最近设备像素，保持 1px 锐利）
        if (ed.mirror.mode === "copy") ctx.fillRect(ox, 0, 1, H);   // 同像源线（左边界）
    }
    if (ed._mqRect) {   // 框选矩形（金色虚线+浅底，与旧 DOM 样式一致）
        const x = Math.round(ox + ed._mqRect.x * s) + 0.5, y = Math.round(oy + ed._mqRect.y * s) + 0.5;
        const w = Math.round(ed._mqRect.w * s), h = Math.round(ed._mqRect.h * s);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(212,175,55,0.9)";
        ctx.fillStyle = "rgba(212,175,55,0.15)";
        ctx.fillRect(x - 0.5, y - 0.5, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
    }
    if (ed.layers[ed.active]) {   // 当前层虚线框：贴内容紧致边（透明边距不计，空层=整块画布）；缩放模式下金框+四角手柄
        const L = ed.layers[ed.active];
        const vb = BF.layerBounds(L) || { x: 0, y: 0, w: L.canvas.width, h: L.canvas.height };
        const bx = Math.round(ox + (L.x + vb.x * L.s) * s) + 0.5, by = Math.round(oy + (L.y + vb.y * L.s) * s) + 0.5;
        const bw = Math.round(vb.w * L.s * s), bh = Math.round(vb.h * L.s * s);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = ed._scaleMode ? "rgba(212,175,55,0.9)" : "rgba(255,255,255,0.9)";   // 选中层：白虚线；缩放调节中：金虚线+四角手柄
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
        if (ed._scaleMode) {
            ctx.fillStyle = "rgba(212,175,55,0.9)";
            ctx.fillRect(bx - 4, by - 4, 8, 8);
            ctx.fillRect(bx + bw - 4, by - 4, 8, 8);
            ctx.fillRect(bx - 4, by + bh - 4, 8, 8);
            ctx.fillRect(bx + bw - 4, by + bh - 4, 8, 8);
            ctx.fillStyle = "rgba(212,175,55,0.55)";   // 四边中点：裁剪手柄（比四角暗一档，区分「缩放/裁剪」）
            ctx.fillRect(bx + bw / 2 - 4, by - 4, 8, 8);
            ctx.fillRect(bx + bw / 2 - 4, by + bh - 4, 8, 8);
            ctx.fillRect(bx - 4, by + bh / 2 - 4, 8, 8);
            ctx.fillRect(bx + bw - 4, by + bh / 2 - 4, 8, 8);
        }
    }
    if (ed._splitLine) {   // 分割工具预览线：按划出的两点方向延伸成整条直线（实际切割用的掩码就是按这条无限直线算的）
        const q = ed._splitLine, dx = q.b.x - q.a.x, dy = q.b.y - q.a.y;
        ctx.strokeStyle = "rgba(212,175,55,0.9)";
        ctx.beginPath();
        ctx.moveTo(ox + (q.a.x - dx * 1e4) * s, oy + (q.a.y - dy * 1e4) * s);
        ctx.lineTo(ox + (q.a.x + dx * 1e4) * s, oy + (q.a.y + dy * 1e4) * s);
        ctx.stroke();
    }
    if (BF.ed.pickSrc) {   // 取色块：被选中的色块用蓝色虚线框住（样板所在处）
        const q = BF.ed.pickSrc;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = "rgba(64,160,255,0.95)";
        ctx.strokeRect(Math.round(ox + q.x * s) + 0.5, Math.round(oy + q.y * s) + 0.5, Math.round(q.w * s), Math.round(q.h * s));
        ctx.setLineDash([]);
    }
};
addEventListener("resize", () => BF.renderStage());   // 视口/缩放变化时舞台画布重设尺寸并重画（无编辑器时自动空转）

/* ---------- 视图（pan/zoom） ---------- */
BF.applyView = function() {
    const v = BF.ed.view, d = window.devicePixelRatio || 1;
    // 视图量化到整数设备像素：让「1 合成像素 = 整数个设备像素」，格线与像素边界都落在整数设备像素上（锐利）。
    // 双指缩放进行中例外：z 保持连续跟手——逐帧在量化值上再放大，会让缩放滞后手指、跨档时猛跳（跳变/跑偏根源），松手再吸附
    if (!BF.ed._pinching) v.z = Math.max(Math.round(v.z * d), 1) / d;
    v.x = Math.round(v.x * d) / d;
    v.y = Math.round(v.y * d) / d;
    BF.renderStage();
    const cur = BF.ed.cursorEl;   // 缩放后光标圈大小立即跟随（不必等指针移动）
    if (cur && cur.style.display === "block" && BF.ed.cursorPos) {
        const d2 = BF.ed.size * v.z;
        cur.style.width = cur.style.height = d2 + "px";
        cur.style.left = BF.ed.cursorPos.x - d2 / 2 + "px";
        cur.style.top = BF.ed.cursorPos.y - d2 / 2 + "px";
    }
};
BF.fitView = function() {
    const r = BF.ed.viewEl.getBoundingClientRect();
    const z = Math.min(r.width / BF.ed.fileW, r.height / BF.ed.fileH) * 0.9;
    BF.ed.view = { x: (r.width - BF.ed.fileW * z) / 2, y: (r.height - BF.ed.fileH * z) / 2, z };
    BF.applyView();
};
BF.zoomBy = function(f) {   // 保底跨 1 设备像素步进：量化后 1.25× 这类小倍率可能四舍五入回原值（原地踏步）
    const r = BF.ed.viewEl.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    const cur = Math.round(BF.ed.view.z * d);
    BF.zoomAt(r.width / 2, r.height / 2, (f > 1 ? Math.max(cur + 1, Math.round(cur * f)) : Math.min(cur - 1, Math.round(cur * f))) / d);
};
BF.zoomAt = function(px, py, z) {
    const v = BF.ed.view, d = window.devicePixelRatio || 1;
    z = Math.min(Math.max(z, 0.5), 24);
    if (!BF.ed._pinching) z = Math.max(Math.round(z * d), 1) / d;   // 先按 applyView 同一规则吸附设备像素档：极限档位上 k 恰为 1
    if (z === v.z) return;   // 档位没变（已到缩放极限还继续滚/点）：直接不动——否则 k≠1 会把画布朝锚点拖走
    const k = z / v.z;
    v.x = px - (px - v.x) * k;
    v.y = py - (py - v.y) * k;
    v.z = z;
    BF.applyView();
};

/* ---------- 人物背景快照：侧栏画布 ÷scale 贴到每个帧区域 ---------- */
BF.snapBackground = function() {
    // #img 里第一个 canvas 是光照层（lighting），必须精确定位人物层
    const side = document.querySelector("#img canvas.mainCanvas")
        || document.querySelector("#img canvas");
    const bg = BF.ed.bg, ctx = bg.getContext("2d");
    ctx.clearRect(0, 0, bg.width, bg.height);
    if (!side) { BF.toast("找不到侧栏人物画布"); BF.renderStage(); return; }
    ctx.imageSmoothingEnabled = false;
    let src = side;
    if (BF.ed.hideClothes) {
        // 藏衣物：借游戏渲染器把「除服装/脸部以外」的图层重画到临时画布（原图层缓存已热，同步完成）
        try {
            const m = Renderer.lastModel;
            const layers = m.compile(m.options).filter(L =>
                !(typeof L.src === "string" && BF.PREFIXES.some(p => L.src.startsWith(p))));
            const c = document.createElement("canvas");
            c.width = side.width; c.height = side.height;
            Renderer.composeLayers(c.getContext("2d"), layers, side.width / m.width, m.listener || Renderer.defaultListener);
            src = c;
        } catch (e) { console.warn("[BF] 隐藏服装重画失败，回退完整人物", e); }
    }
    const w = BF.ed.fileH;   // 每帧区域宽 = fileH（双帧 256×128 → 每帧 128×128）
    for (let f = 0; f < BF.ed.frames; f++) {
        ctx.drawImage(src, 0, 0, side.width, side.height, f * w, 0, w, BF.ed.fileH);
    }
    BF.renderStage();
};

/* ---------- 指针交互：单指=工具，双指/滚轮=视图 ---------- */
BF.bindPointer = function() {
    const view = BF.ed.viewEl;
    const pts = new Map();
    let pinch = null, stroke = null;

    const toFile = e => {   // 视口坐标 → 合成坐标（与舞台画布同一套数学，不再依赖画布矩形）
        const r = view.getBoundingClientRect(), v = BF.ed.view;
        return { x: (e.clientX - r.left - v.x) / v.z,
                 y: (e.clientY - r.top - v.y) / v.z };
    };

    view.addEventListener("pointerdown", e => {
        view.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (e.button === 1) {   // 鼠标中键 = 拖拽平移视图（preventDefault 同时拦掉浏览器中键自动滚动）
            stroke = { kind: "pan", last: { x: e.clientX, y: e.clientY } };
            e.preventDefault();
            return;
        }
        if (pts.size === 2) {
            if (stroke) { stroke = null; }                       // 双指介入时终止笔迹
            const [a, b] = [...pts.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y),
                      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
            BF.ed._pinching = true;   // 缩放进行中：视图 z 不量化（跟手），松手时吸附回档位
        } else if (pts.size === 1) {
            stroke = BF.toolDown(e, toFile(e));
        }
        e.preventDefault();
    });
    view.addEventListener("pointermove", e => {
        if (!pts.has(e.pointerId)) return;
        const p = pts.get(e.pointerId);
        if (pts.size === 2 && pinch) {
            p.x = e.clientX; p.y = e.clientY;
            const [a, b] = [...pts.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const v = BF.ed.view, r = view.getBoundingClientRect();
            BF.zoomAt(pinch.mx - r.left, pinch.my - r.top, v.z * d / pinch.d);
            v.x += mx - pinch.mx; v.y += my - pinch.my;
            pinch = { d, mx, my };
            BF.applyView();
        } else if (pts.size === 1 && stroke) {
            BF.toolMove(stroke, e, toFile(e));
            p.x = e.clientX; p.y = e.clientY;
        }
    });
    const up = e => {
        pts.delete(e.pointerId);
        if (pts.size < 2 && pinch) {   // 双指缩放结束：以最后中点为锚吸附回整数设备像素档位（内容不跳位，恢复锐利）
            const p = pinch, ed = BF.ed;
            pinch = null;
            if (ed) {
                ed._pinching = false;
                const d0 = window.devicePixelRatio || 1, v = ed.view;
                const qz = Math.max(Math.round(v.z * d0), 1) / d0;
                if (qz !== v.z) {
                    const r = view.getBoundingClientRect();
                    BF.zoomAt(p.mx - r.left, p.my - r.top, qz);
                } else BF.applyView();
            }
        }
        if (stroke) { BF.toolUp(stroke); stroke = null; }
    };
    view.addEventListener("pointerup", up);
    view.addEventListener("pointercancel", up);
    // 画笔/橡皮光标范围圈：桌面悬停即显，触屏按下才显（大小 = 粗细 × 视图缩放）
    const cur = document.createElement("div");
    cur.className = "bfCursor";
    view.appendChild(cur);
    BF.ed.cursorEl = cur;
    const showCursor = e => {
        if (BF.ed._scaleMode) {   // 缩放调节中：悬停四角换对角拉伸光标（对角同向↔nwse，反对向↔nesw），其余复位
            if (e.pointerType === "mouse") {
                const L = BF.ed.layers[BF.ed.active], pt = toFile(e);
                const vb = L && (BF.layerBounds(L) || { x: 0, y: 0, w: L.canvas.width, h: L.canvas.height });
                const g = 10 / BF.ed.view.z;
                const hit = vb && [[vb.x, vb.y, "nwse"], [vb.x + vb.w, vb.y + vb.h, "nwse"],
                                   [vb.x + vb.w, vb.y, "nesw"], [vb.x, vb.y + vb.h, "nesw"],
                                   [vb.x, vb.y + vb.h / 2, "ew"], [vb.x + vb.w, vb.y + vb.h / 2, "ew"],   // 四边中点：裁剪（横向/纵向拉伸光标）
                                   [vb.x + vb.w / 2, vb.y, "ns"], [vb.x + vb.w / 2, vb.y + vb.h, "ns"]]
                    .find(c => Math.abs(pt.x - (L.x + c[0] * L.s)) <= g && Math.abs(pt.y - (L.y + c[1] * L.s)) <= g);
                view.style.cursor = hit ? hit[2] + "-resize" : "";
            }
            cur.style.display = "none";
            return;
        }
        const paint = BF.ed && (BF.ed.tool === "brush" || BF.ed.tool === "eraser");
        if (!paint || (e.pointerType !== "mouse" && pts.size === 0)) { cur.style.display = "none"; return; }
        const d = BF.ed.size * BF.ed.view.z, r = view.getBoundingClientRect();
        BF.ed.cursorPos = { x: e.clientX - r.left, y: e.clientY - r.top };   // 记住位置，applyView 缩放时复用
        cur.style.display = "block";
        cur.style.width = cur.style.height = d + "px";
        cur.style.left = BF.ed.cursorPos.x - d / 2 + "px";
        cur.style.top = BF.ed.cursorPos.y - d / 2 + "px";
    };
    view.addEventListener("pointermove", showCursor);
    view.addEventListener("pointerdown", showCursor);
    view.addEventListener("pointerleave", () => cur.style.display = "none");
    const hideCursor = e => { if (e.pointerType !== "mouse") cur.style.display = "none"; };
    view.addEventListener("pointerup", hideCursor);
    view.addEventListener("pointercancel", hideCursor);
};

BF.toolDown = function(e, pt) {
    const ed = BF.ed;
    ed.panel.querySelector(".bfMarqueeMenu")?.remove();   // 重新操作画布即收起上一次的框选选择浮层
    ed._mqRect = null; ed._splitLine = null;
    BF.renderStage();
    if (ed.pickSrc !== undefined) {   // 取色块模式：第一次点=取全图层所见色块当样板，之后每次点=往同一个图层盖一块（配方落库、游戏里重演，不碰被污染像素）
        const s0 = Math.max(1, Math.round(ed.size));
        const rq = { x: Math.round(pt.x - s0 / 2), y: Math.round(pt.y - s0 / 2), w: s0, h: s0 };
        if (!ed.pickSrc) {   // 取样板：全图层合成所见像素（不看选中层、不分笔迹，连「取色涂」自己也能取），统一生成一个色块配方
            const a = BF.assemblePiece(rq);
            if (!a) { BF.toast("取色失败：原图受浏览器安全限制"); return null; }
            if (!a.ok) { BF.toast("这里没有内容，换个有像素的地方取"); return null; }
            ed.pickSrc = { pc: a.piece, tile: a.canvas, x: rq.x, y: rq.y, w: rq.w, h: rq.h };
            BF.renderStage();   // 蓝色虚线框标出被选中的色块
            BF.toast("已选中色块：每次点画布盖一块");
            return null;
        }
        let SL = ed.layers.find(x => x.piece?.stamp);   // 画下的所有色块堆进同一个图层（piece.stamp 标记随配方落库，重开后继续用同一层）
        if (!SL) {
            const c = document.createElement("canvas");
            c.width = ed.fileW; c.height = ed.fileH;
            SL = { canvas: c, ctx: c.getContext("2d"), name: "取色涂", visible: true, x: 0, y: 0, s: 1, noExport: true,
                   piece: { x: 0, y: 0, s: 1, w: ed.fileW, h: ed.fileH, ox: 0, oy: 0, sx: 0, sy: 0, sw: 0, sh: 0, ink: 0, refs: [], stamp: 1 } };
            const at = ed.layers.findIndex(L2 => !L2.noExport);
            ed.layers.splice(at < 0 ? ed.layers.length : at, 0, SL);
            if (at >= 0 && at <= ed.active) ed.active++;   // 新层插在选中层之前：选中索引跟着后移，保住用户原来选中的层
            BF.pushUndo([]).push({ L: SL, inList: false, x: 0, y: 0, s: 1 });   // 否定快照：撤销时整层移除
            BF.syncLayers();
        } else BF.pushUndo(SL);   // refs 长度进快照：撤销退回上一块
        const lx = (rq.x - SL.x) / SL.s, ly = (rq.y - SL.y) / SL.s;   // 换算到印章层自身坐标（层被移动/缩放过也对得上）
        const top = ed.pickSrc.tile;
        const put = (x, s, y) => {   // 盖一块：s=-1 即左右翻折（复像「镜像」用）；配方与画布同步，游戏里重演得到同一结果
            SL.piece.refs.push({ pc: BF.plainPiece(ed.pickSrc.pc), x, y, s });
            SL.ctx.save();
            SL.ctx.translate(x, y);
            SL.ctx.scale(s, 1);
            SL.ctx.drawImage(top, 0, 0);   // 增量为 O(1)：样板只渲染一次，之后逐块贴，连续涂不卡
            SL.ctx.restore();
        };
        put(lx, 1, ly);
        const m = ed.mirror;   // 复像联动：镜像=轴对面对称位置再盖一块翻折的；同像=线两侧互相同步各盖一块（朝向不变）
        if (m?.on) {
            if (m.mode === "flip") put(2 * (m.x - SL.x) / SL.s - lx, -1, ly);
            else put(lx + (rq.x < m.x ? m.x : -m.x) / SL.s, 1, ly);
        }
        BF.renderStage();
        return null;
    }
    let L = ed.layers[ed.active];
    if (ed._scaleMode && L) {   // 缩放调节中：四角手柄（屏幕 10px）拖拽缩放（锚定对角）+ 拖层移动，其余工具拦截
        const vb = BF.layerBounds(L) || { x: 0, y: 0, w: L.canvas.width, h: L.canvas.height };
        const g = 10 / ed.view.z;
        const cs = [[vb.x, vb.y, vb.x + vb.w, vb.y + vb.h], [vb.x + vb.w, vb.y, vb.x, vb.y + vb.h],
                    [vb.x, vb.y + vb.h, vb.x + vb.w, vb.y], [vb.x + vb.w, vb.y + vb.h, vb.x, vb.y]];   // [角x, 角y, 对角x, 对角y]（层画布坐标）
        for (const c of cs) {
            const cx = L.x + c[0] * L.s, cy = L.y + c[1] * L.s;
            if (Math.abs(pt.x - cx) <= g && Math.abs(pt.y - cy) <= g) {
                const multi = ed._scaleSel?.length > 1;
                BF.pushUndo(multi ? ed._scaleSel : L);
                return { kind: "scaleGrip", L, startS: L.s, hx: c[2], hy: c[3],   // hx/hy=对角（层画布坐标）
                         ax: L.x + c[2] * L.s, ay: L.y + c[3] * L.s,   // 对角锚点（合成坐标，拖动中固定）
                         d0: Math.max(0.5, Math.hypot(pt.x - (L.x + c[2] * L.s), pt.y - (L.y + c[3] * L.s))),
                         base: multi ? ed._scaleSel.filter(S => S !== L).map(S => ({ S, x: S.x, y: S.y, s: S.s })) : null };   // 多选：其余层起始状态（拖动时整组绕同一锚点 ax/ay 同比值缩放）
            }
        }
        const es = [[vb.x, vb.y + vb.h / 2, "l"], [vb.x + vb.w, vb.y + vb.h / 2, "r"], [vb.x + vb.w / 2, vb.y, "t"], [vb.x + vb.w / 2, vb.y + vb.h, "b"]];
        for (const e of es) {   // 四边中点：拖该边裁剪（其余三边不动）
            if (Math.abs(pt.x - (L.x + e[0] * L.s)) <= g && Math.abs(pt.y - (L.y + e[1] * L.s)) <= g) {
                BF.pushUndo(L === ed.layers[0] ? [L, { canvas: ed.erase, ctx: ed.eraseCtx, x: 0, y: 0, s: 1 }] : L);   // 原图层裁剪动的是全局擦除遮罩，快照须一并覆盖
                if (!L.crop) L.crop = { l: vb.x, t: vb.y, r: L.canvas.width - vb.x - vb.w, b: L.canvas.height - vb.y - vb.h };   // 首次裁剪：以当前紧致框为基准，避免其余三边跳回整块画布
                return { kind: "cropGrip", L, edge: e[2] };
            }
        }
        if (ed.tool !== "move") return null;   // 工具兜底拦截（按钮已禁，防组合/键盘等旁路入口）
    }
    // 原图层/复制块只允许移动/缩放/橡皮/框选（导出不含原图像素）；画笔自动切到（必要时新建）编辑图层
    if (L.noExport && ed.tool === "brush") {
        let t = ed.layers.findIndex(x => !x.noExport);
        if (t < 0) { BF.addLayer(); t = ed.layers.length - 1; }
        ed.active = t;
        L = ed.layers[t];
        BF.syncLayers(); BF.syncTools();
        BF.toast("已在编辑图层上绘制（原图层/复制块支持移动/缩放/橡皮/框选）");
    }
    if (ed.tool === "move") {
        const sel = ed._scaleMode && ed._scaleSel?.length > 1 ? ed._scaleSel : null;   // 缩放多选：拖层 = 整组一起移动（与一起缩放同款）
        BF.pushUndo(ed.groupMove ? ed.layers : sel || L);   // 组合模式/缩放多选：整组一步撤销
        return { kind: "move", L, sel, last: { x: e.clientX, y: e.clientY } };
    }
    if (ed.tool === "marquee") return { kind: "marquee", start: pt, last: pt };   // 松手弹出 复制/删除 选择
    if (ed.tool === "split") return { kind: "split", L, start: pt, last: pt };
    // 本笔镜像参数。镜像 flip：以线为轴逐像素翻折（轴换算进 stampDot）；同像 copy：线两侧互相同步，
    // dx=线位置（在 stampDot 内按笔点所在侧取 ±——左边界→线的段复制到线右、线的段复制回左边界侧）
    const mir = ed.mirror?.on ? { ...ed.mirror, dx: ed.mirror.mode === "copy" ? ed.mirror.x : 0 } : null;
    if (ed.tool === "eraser") {
        // 橡皮只作用于当前选中的图层：
        //   笔迹层 → 直接 destination-out 擦本层（保存后随笔迹一起生效）；
        //   原图层 → 擦除记入干净遮罩（原图像素不能导出），渲染时遮罩只抠原图、不影响复制块；
        //   复制块 → 块画布被原图污染读不出像素，擦除同样记入块遮罩（干净画布，可导出），
        //            块画布同步 destination-out 抠显示；撤销走遮罩快照 + 全量重画（redrawPiece）
        if (L.piece) {
            const pc = L.piece;
            if (!pc.maskCanvas) {   // 惰性建块遮罩：尺寸=块画布，只有擦过才存在（省内存、旧数据无需迁移）
                pc.maskCanvas = document.createElement("canvas");
                pc.maskCanvas.width = L.canvas.width; pc.maskCanvas.height = L.canvas.height;
            }
            const mc = pc.maskCanvas.getContext("2d");
            L.pmDirty = true;
            BF.pushUndo(L);
            mc.globalCompositeOperation = "source-over"; mc.globalAlpha = 1;
            L.ctx.globalCompositeOperation = "destination-out"; L.ctx.globalAlpha = 1;
            const ctxs = [{ c: mc, col: "#000", L }, { c: L.ctx, col: "#000", L }];   // 双目标同一点：遮罩记档 + 块画布即时显示
            BF.stampDot(ctxs, pt.x, pt.y, mir);
            return { kind: "draw", L, ctxs, mir, last: pt };
        }
        if (L.noExport) {
            BF.pushUndo([L, { canvas: ed.erase, ctx: ed.eraseCtx, x: 0, y: 0, s: 1 }]);
            ed.eraseDirty = true;
            ed.eraseCtx.globalCompositeOperation = "source-over";
            ed.eraseCtx.globalAlpha = 1;
            BF.stampDot([{ c: ed.eraseCtx, col: "#000" }], pt.x, pt.y, mir);
            BF.redrawBase();
            return { kind: "draw", L, ctxs: [{ c: ed.eraseCtx, col: "#000" }], erase: true, mir, last: pt };
        }
        BF.pushUndo(L);
        L.ctx.globalCompositeOperation = "destination-out";
        L.ctx.globalAlpha = 1;
        BF.stampDot([{ c: L.ctx, col: "#000", L }], pt.x, pt.y, mir);
        return { kind: "draw", L, ctxs: [{ c: L.ctx, col: "#000", L }], mir, last: pt };
    }
    BF.pushUndo(L);
    const ctx = L.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = ed.alpha;
    BF.stampDot([{ c: ctx, L }], pt.x, pt.y, mir);   // 点一下也算一笔
    return { kind: "draw", L, ctxs: [{ c: ctx, L }], mir, last: pt };
};
BF.toolMove = function(s, e, pt) {
    if (s.kind === "pan") {   // 中键平移视图
        const v = BF.ed.view;
        v.x += e.clientX - s.last.x; v.y += e.clientY - s.last.y;
        s.last = { x: e.clientX, y: e.clientY };
        BF.applyView();
        return;
    }
    if (s.kind === "move") {
        const ed = BF.ed;
        const dx = (e.clientX - s.last.x) / ed.view.z;   // 指针位移 ÷ 视图缩放 = 合成位移（无需量画布矩形，也不再强制排版）
        const dy = (e.clientY - s.last.y) / ed.view.z;
        s.last = { x: e.clientX, y: e.clientY };
        (ed.groupMove ? ed.layers : s.sel || [s.L]).forEach(L2 => { L2.x += dx; L2.y += dy; BF.applyLayer(L2); });   // 松手时才吸附，拖动过程完全跟手
        BF.renderStage();
    } else if (s.kind === "marquee") {
        s.last = pt;
        BF.marqueeRect(s.start, pt);
    } else if (s.kind === "scaleGrip") {   // 缩放手柄：锚定对角，对角线距离比例缩放（钳制 25%~400%），对角固定不动
        const L = s.L;
        const s2 = Math.round(Math.min(4, Math.max(0.25, s.startS * Math.hypot(pt.x - s.ax, pt.y - s.ay) / s.d0)) * 100) / 100;
        const r = s2 / s.startS;
        L.x = s.ax - s.hx * s2;
        L.y = s.ay - s.hy * s2;
        L.s = s2;
        for (const b of s.base || []) {   // 多选：整组绕同一锚点（被拖层的对角 s.ax/s.ay）同比值缩放——位置与尺寸一起缩放，各层相对关系整体保持
            b.S.s = Math.min(4, Math.max(0.25, b.s * r));
            const rr = b.S.s / b.s;
            b.S.x = s.ax + (b.x - s.ax) * rr;
            b.S.y = s.ay + (b.y - s.ay) * rr;
            BF.applyLayer(b.S);
        }
        BF.applyLayer(L); BF.renderStage();
    } else if (s.kind === "cropGrip") {   // 裁剪手柄：被拖的边跟随指针，其余三边不动（画布像素，至少留 1px）
        const L = s.L, cp = L.crop, W = L.canvas.width, H = L.canvas.height;
        const lx = Math.round((pt.x - L.x) / L.s), ly = Math.round((pt.y - L.y) / L.s);
        const cl = (v, hi) => Math.min(hi, Math.max(0, v));
        if (s.edge === "l") cp.l = cl(lx, W - cp.r - 1);
        else if (s.edge === "r") cp.r = cl(W - lx, W - cp.l - 1);
        else if (s.edge === "t") cp.t = cl(ly, H - cp.b - 1);
        else cp.b = cl(H - ly, H - cp.t - 1);
        BF.renderStage();
    } else if (s.kind === "split") {   // 分割预览线
        if (e?.shiftKey) {   // 按住 Shift：方向吸附到 0/45/90/135（横/斜/竖），两端落整像素——切出来的掩码边界才锐利
            const a0 = { x: Math.round(s.start.x), y: Math.round(s.start.y) };
            const dx = pt.x - a0.x, dy = pt.y - a0.y;
            const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 3;   // 0=横 1=斜45 2=竖 3=斜135（线方向按 180 度循环，135 等同 -45）
            if (k & 1) { const d = Math.round((Math.abs(dx) + Math.abs(dy)) / 2); pt = { x: a0.x + Math.sign(dx) * d, y: a0.y + Math.sign(dy) * d }; }   // 斜：两轴取同一长度，正好 45°
            else if (k === 0) pt = { x: Math.round(pt.x), y: a0.y };
            else pt = { x: a0.x, y: Math.round(pt.y) };
            s.start = a0;   // 起点也落整像素：横/竖线才会正好压在像素网格线上
        }
        s.last = pt;
        BF.ed._splitLine = { a: s.start, b: pt };
        BF.renderStage();
    } else {
        BF.stampLine(s.ctxs, s.last, pt, s.mir);
        s.last = pt;   // 像素笔逐段绘制：必须推进上一点，否则每段都从起点连线（快速画圈会糊成实心圆）
        s.L._bndsDirty = true;   // 内容变了：紧致边框缓存失效（擦除时边框随笔画收缩、画空层时退回整块画布）
        if (s.erase) BF.redrawBase();   // 原图层遮罩变了，原图层预览跟着重画（内部含 renderStage）
        else BF.renderStage();          // 笔迹画在离屏画布上，舞台重画后才可见
    }
};
BF.toolUp = function(s) {
    if (s.kind === "draw") { s.ctxs.forEach(x => { x.c.globalCompositeOperation = "source-over"; x.c.globalAlpha = 1; }); s.L._bndsDirty = true; BF.syncLayers(); }   // syncLayers 内部会重画舞台：紧致边框与空层斜纹同步刷新
    else if (s.kind === "move") {   // 松手吸附到合成画布整像素：游戏按整像素位移应用修正，半像素必然糊边（拖动过程不吸附以保持跟手）
        (BF.ed.groupMove ? BF.ed.layers : s.sel || [s.L]).forEach(L2 => {
            L2.x = Math.round(L2.x);
            L2.y = Math.round(L2.y);
            BF.applyLayer(L2);
        });
        BF.renderStage();
    }
    else if (s.kind === "marquee") BF.marqueeMenu(s.start, s.last);
    else if (s.kind === "split") BF.splitLayer(s);
};

// 分割：沿划出的直线把图层一分为二（行进方向右侧 → 新图层）。
// 笔迹层直接按掩码搬像素；复制块配方不动、两侧各记互补遮罩（原块抠右侧，新块=同配方+抠左侧的遮罩）；
// 原图层/配件参考层拆成两张互补的整图配方（原图层隐藏、配件层由两半替换，渲染时由两张配方拼回原样）。
// 勾了「全图切割」（ed.splitAll）时对全部可见图层各切一刀：n 张 → 2n 张，原来那几张原位换成两半
BF.splitLayer = function(s) {
    const ed = BF.ed, a = s.start, b = s.last;
    ed._splitLine = null;
    BF.renderStage();
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) return;   // 划线太短：误触不算
    const targets = ed.splitAll ? ed.layers.filter(L => L.visible) : [s.L];
    const grp = BF.pushUndo(targets);
    const done = new Map();   // 被切层 → [左半（原层那侧）, 右半（新层）]
    for (const L of targets) {
        const ax = (a.x - L.x) / L.s, ay = (a.y - L.y) / L.s, bx = (b.x - L.x) / L.s, by = (b.y - L.y) / L.s;   // 划线两端换算到本层画布坐标（各层位移/缩放不同，逐层算）
        const sideMask = (sign, W = L.canvas.width, H = L.canvas.height, k = 1) => {   // 直线某一侧的多边形掩码（sign=1 行进方向右侧 cross>0，-1 左侧）；k=线坐标缩放（配方画布与原层画布尺寸不同）
            const px = ax * k, py = ay * k, dx = (bx - ax) * k, dy = (by - ay) * k;   // 起点 + 方向（已换算到掩码画布坐标）
            const n = { x: -dy * sign, y: dx * sign }, BIG = 1e5;
            const m = document.createElement("canvas");
            m.width = W; m.height = H;
            const mc = m.getContext("2d");
            mc.fillStyle = "#000";
            mc.beginPath();
            mc.moveTo(px - dx * BIG, py - dy * BIG);
            mc.lineTo(px + dx * (BIG + 1), py + dy * (BIG + 1));
            mc.lineTo(px + dx * (BIG + 1) + n.x * BIG, py + dy * (BIG + 1) + n.y * BIG);
            mc.lineTo(px - dx * BIG + n.x * BIG, py - dy * BIG + n.y * BIG);
            mc.closePath();
            mc.fill();
            return m;
        };
        // 分割线某一侧的包围盒（画布坐标的裁剪框，框=保留区）：画布四角里落在该侧的点 + 直线与画布边的交点，取包围盒。
        // 框外像素必定在直线另一侧，裁掉它不会丢内容 —— 不必读像素，复制块/原图的污染画布同样适用；线越接近水平/竖直裁得越多
        const cutSide = (sign, W, H, k) => {
            const px = ax * k, py = ay * k, dx = (bx - ax) * k, dy = (by - ay) * k, nx = -dy * sign, ny = dx * sign;
            const f = (x, y) => (x - px) * nx + (y - py) * ny, P = [[0, 0], [W, 0], [W, H], [0, H]], pts = [];
            for (let i = 0; i < 4; i++) {
                const p = P[i], q = P[(i + 1) % 4], fp = f(p[0], p[1]), fq = f(q[0], q[1]);
                if (fp >= 0) pts.push(p);
                if ((fp >= 0) !== (fq >= 0)) { const t = fp / (fp - fq); pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
            }
            if (!pts.length) return null;   // 线整个落在层外：分不清两侧，不裁
            const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
            return { l: Math.floor(Math.min(...xs)), t: Math.floor(Math.min(...ys)),
                     r: W - Math.ceil(Math.max(...xs)), b: H - Math.ceil(Math.max(...ys)) };
        };
        // 半块命名按画面上看到的方位、不看画线方向：线偏横 → 上/下，线偏竖 → 左/右。
        // sign=该半块遮罩所在的那一侧，保留的是另一侧，故判断用 −sign 的方向（=保留区朝哪边）
        const sideName = sign => Math.abs(bx - ax) >= Math.abs(by - ay)
            ? ((bx - ax) * sign < 0 ? " 分割下" : " 分割上")
            : ((by - ay) * sign > 0 ? " 分割右" : " 分割左");
        const mB = sideMask(1);
        if (L.piece) {   // 复制块 / 已被分割过的配件层：配方不动、两侧各记互补遮罩（配方里已含该取哪张原图、哪段笔迹）
            const ref = L.gSrc ? BF.seen.get(L.gSrc) : BF.seen.get(ed.src);   // 配件层按部件自己的原图重演，复制块按主文件原图
            if (!L.piece.maskCanvas) {   // 惰性建块遮罩（同橡皮）
                L.piece.maskCanvas = document.createElement("canvas");
                L.piece.maskCanvas.width = L.canvas.width; L.piece.maskCanvas.height = L.canvas.height;
            }
            L.piece.maskCanvas.getContext("2d").drawImage(mB, 0, 0);   // 原块：右侧记档
            L.ctx.globalCompositeOperation = "destination-out";
            L.ctx.drawImage(mB, 0, 0);
            L.ctx.globalCompositeOperation = "source-over";
            L.pmDirty = true;
            L.crop = cutSide(-1, L.canvas.width, L.canvas.height, 1);   // 原块只剩左侧：可视框收到左侧（框=保留区，与遮罩记档的右侧互补；画布读不了像素，见 cutSide 注释）
            const pc2 = { ...L.piece, maskCanvas: sideMask(-1) };   // 新块：同配方，遮罩=左侧（只剩右侧内容）
            const c2 = BF.renderPiece(pc2, ref, L.gSrc ? null : ed.erase, BF.inkSnap(), pc2.maskCanvas);
            const NL = { canvas: c2, ctx: c2.getContext("2d"), name: L.name + " 分割", visible: true, x: L.x, y: L.y, s: L.s, noExport: true, piece: pc2, pmDirty: true, crop: cutSide(1, L.canvas.width, L.canvas.height, 1) };
            if (L.gSrc) Object.assign(NL, { gSrc: L.gSrc, locked: true, gScale: L.gScale, gData: L.gData, gInit: [L.x, L.y, L.s] });
            done.set(L, [L, NL]);
            continue;
        }
        if (L.locked) {   // 原图层 / 配件参考层：拆成两张互补的整图配方（互补遮罩），各自只显示自己那一侧
            if (L.gSrc) {   // 配件参考层：配方直接采该部件自己的原图 + 已保存笔迹，落库到该部件自己的修正里
                const N = L.canvas.width, M = L.canvas.height, gf = BF.store.get(L.gSrc);
                const half = sign => {
                    const mask = sideMask(sign, N, M, 1);
                    const pc = { x: L.x, y: L.y, s: L.s, w: N, h: M, ox: 0, oy: 0, sx: 0, sy: 0, sw: N, sh: M, ink: 1, inkURL: gf?.dataURL, maskCanvas: mask };
                    const c = BF.renderPiece(pc, BF.seen.get(L.gSrc), null, gf?.img, mask);
                    return { canvas: c, ctx: c.getContext("2d"), name: L.name + sideName(sign), visible: true, x: L.x, y: L.y, s: L.s, noExport: true,
                             gSrc: L.gSrc, gScale: L.gScale, gData: L.gData, gInit: [L.x, L.y, L.s], piece: pc, pmDirty: true, crop: cutSide(-sign, N, M, 1) };
                };
                done.set(L, [half(1), half(-1)]);
                continue;
            }
            const W = Math.max(1, Math.round(L.canvas.width * L.s)), H = Math.max(1, Math.round(L.canvas.height * L.s));
            const half = sign => {
                const mask = sideMask(sign, W, H, L.s);
                const pc = { x: L.x, y: L.y, s: 1, w: W, h: H, ox: L.x, oy: L.y, sx: 0, sy: 0, sw: L.canvas.width, sh: L.canvas.height, ink: 0, maskCanvas: mask };
                const c = BF.renderPiece(pc, BF.seen.get(ed.src), ed.erase, null, mask);
                return { canvas: c, ctx: c.getContext("2d"), name: L.name + sideName(sign), visible: true, x: L.x, y: L.y, s: 1, noExport: true, piece: pc, pmDirty: true, crop: cutSide(-sign, W, H, L.s) };
            };
            L.visible = false;   // 原图层让位（saveFix 见 tf 置空，渲染时不再画整张原图；显隐进快照，撤销时显回）
            done.set(L, [half(1), half(-1)]);
            continue;
        }
        let has = false;   // 笔迹层：先确认右侧有内容再动手（画布干净可读）
        try {
            const dd = mB.getContext("2d").getImageData(0, 0, mB.width, mB.height).data;
            for (let k = 3; k < dd.length; k += 4) if (dd[k]) { has = true; break; }
        } catch (e) { /* 理论不可达 */ }
        if (!has) continue;
        const c2 = document.createElement("canvas");
        c2.width = L.canvas.width; c2.height = L.canvas.height;
        const c2c = c2.getContext("2d");
        c2c.drawImage(L.canvas, 0, 0);
        c2c.globalCompositeOperation = "destination-in";
        c2c.drawImage(mB, 0, 0);
        L.ctx.globalCompositeOperation = "destination-out";
        L.ctx.drawImage(mB, 0, 0);
        L.ctx.globalCompositeOperation = "source-over";
        L._bndsDirty = true;
        const NL = { canvas: c2, ctx: c2c, name: L.name + " 分割", visible: true, x: L.x, y: L.y, s: L.s, _bndsDirty: true };
        BF.tighten(L); BF.tighten(NL);   // 两半各裁到内容框：笔迹层画布原本是整张原图大小，不裁会各拖一张全宽高空白
        done.set(L, [L, NL]);
    }
    if (!done.size) { BF.toast(ed.splitAll ? "这条线没切到任何内容" : "划线方向右侧没有内容"); return; }   // 失败不退出分割模式，便于重试
    const out = [];
    let firstNew = -1;
    for (const L of ed.layers) {
        const r = done.get(L);
        if (!r) { out.push(L); continue; }
        if (L === ed.layers[0]) { out.push(L); continue; }   // 原图层留在原位（已隐藏），两半稍后插到笔迹层之下，与 composeFix 渲染顺序一致
        if (firstNew < 0) firstNew = out.length;
        out.push(r[0], r[1]);
    }
    const r0 = done.get(ed.layers[0]);
    if (r0) {   // 3 张 → 6 张：每个被切层原位换成两半，被切的原层不再保留（原图层只隐藏，位置留着）
        firstNew = out.findIndex(L2 => !L2.noExport);
        if (firstNew < 0) firstNew = out.length;
        out.splice(firstNew, 0, r0[0], r0[1]);
    }
    ed.layers = out;
    done.forEach(r => grp.push({ L: r[0], inList: false, x: r[0].x, y: r[0].y, s: r[0].s }, { L: r[1], inList: false, x: r[1].x, y: r[1].y, s: r[1].s }));   // 否定快照：撤销时两半一并移除
    ed.active = Math.max(0, firstNew);
    ed.tool = "move";   // 分割完成自动退出
    BF.syncLayers(); BF.syncTools();
    BF.toast(ed.splitAll ? "全图切割完成：每层已分成两半" : "已分割：划线方向右侧 → 新图层");
};

// 像素级笔点（PS 铅笔风）：无抗锯齿无扩散。size 奇数对齐像素中心、偶数对齐格角，
// 圆内整数像素逐个 fillRect —— size=1 恰好单像素，任何尺寸都是硬边。
// 坐标统一用合成坐标，按目标画布所属图层变换换算——图层移动/缩放后笔点仍落在指针处、镜像线仍是那条线。
// mir = { x:镜像线(合成坐标), mode:"flip"|"copy", dx:同像线位置（stampDot 内按笔点所在侧取 ±） }
BF.stampDot = function(ctxs, x, y, mir) {
    const size = BF.ed.size, r = size / 2;
    for (const c of ctxs) {
        const L = c.L, s = L?.s ?? 1, ox = L?.x ?? 0, oy = L?.y ?? 0;   // 遮罩/合成尺寸画布无 L = 恒等变换
        const lx = (x - ox) / s, ly = (y - oy) / s;   // 复合坐标 → 本画布像素坐标
        const put = (ccx, ccy, mi) => {   // 盖一个 size 像素圆点；mi 为可选列映射（镜像翻转用）
            const px = size % 2 ? Math.floor(ccx) + 0.5 : Math.round(ccx);
            const py = size % 2 ? Math.floor(ccy) + 0.5 : Math.round(ccy);
            c.c.fillStyle = c.col ?? BF.ed.color;
            for (let j = Math.floor(py - r); j <= Math.ceil(py + r); j++)
                for (let i = Math.floor(px - r); i <= Math.ceil(px + r); i++)
                    if ((i + 0.5 - px) ** 2 + (j + 0.5 - py) ** 2 <= r * r) c.c.fillRect(mi ? mi(i) : i, j, 1, 1);
        };
        put(lx, ly);   // 原笔点
        if (!mir) continue;
        if (mir.mode === "flip") put(lx, ly, i => Math.round(2 * (mir.x - ox) / s) - 1 - i);   // 镜像：轴换算到本画布（半像素精度）后逐像素翻转
        else put((x + (x < mir.x ? mir.dx : -mir.dx) - ox) / s, ly);   // 同像：双向同步——左侧笔点右移线位、右侧笔点左移线位（朝向不变）
    }
};
BF.stampLine = function(ctxs, a, b, mir) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let i = 0; i <= n; i++) BF.stampDot(ctxs, a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n, mir);
};

// 框选：拖拽时显示选区矩形（栈坐标），松手弹出「复制 / 删除」选择。
// 复制块同原图层一样标记 noExport：saveFix 跳过、snapshot 不读像素、永不 toDataURL——
// 污染画布只写不读，drawImage 仅用于显示预览（与 openEditor 原图层 base 的画法一致），导出链路不受影响
BF.marqueeRect = function(a, b) {   // 选区矩形画进舞台（_mqRect 由 renderStage 绘制）
    BF.ed._mqRect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    BF.renderStage();
};
// 选区几何统一处理：返回 null 表示太小；{ x,y,w,h } 栈坐标 + { sx,sy,cx,cy,cw,ch } 原图坐标（按 L0 反推裁剪）
BF.marqueeZone = function(a, b) {
    const ed = BF.ed, o = BF.seen.get(ed.src), L0 = ed.layers[0];
    const x = Math.max(0, Math.min(a.x, b.x)), y = Math.max(0, Math.min(a.y, b.y));
    const w = Math.min(ed.fileW, Math.max(a.x, b.x)) - x, h = Math.min(ed.fileH, Math.max(a.y, b.y)) - y;
    if (w < 2 || h < 2) return null;
    const sx = (x - L0.x) / L0.s, sy = (y - L0.y) / L0.s, sw = w / L0.s, sh = h / L0.s;
    const cx = Math.max(0, sx), cy = Math.max(0, sy);
    const cw = Math.min(o.naturalWidth, sx + sw) - cx, ch = Math.min(o.naturalHeight, sy + sh) - cy;
    return { x, y, w, h, sx, sy, cx, cy, cw: Math.max(0, cw), ch: Math.max(0, ch) };
};
// 松手菜单：复制为补块图层 / 删除选区内容
BF.marqueeMenu = function(a, b) {
    const ed = BF.ed;
    ed._mq = BF.marqueeZone(a, b);
    if (!ed._mq) { ed._mqRect = null; BF.renderStage(); return; }
    ed.panel.querySelector(".bfMarqueeMenu")?.remove();
    const r = ed.viewEl.getBoundingClientRect(), v = ed.view, m = ed._mq;
    const menu = BF.h(`<div class="bfMarqueeMenu">
        <button class="bfBtn" data-a="copy">复制</button>
        <button class="bfBtn" data-a="del">删除</button>
        <button class="bfBtn" data-a="no">取消</button>
    </div>`);
    menu.style.left = Math.min(r.left + v.x + (m.x + m.w) * v.z + 8, innerWidth - 170) + "px";
    menu.style.top = Math.min(r.top + v.y + m.y * v.z + 8, innerHeight - 60) + "px";
    menu.addEventListener("click", e => {
        const act = e.target.dataset?.a;
        if (!act) return;
        menu.remove(); ed._mqRect = null; BF.renderStage();
        if (act === "copy") BF.copyRect(ed._mq, null, null, ed.layers[ed.active].name + " 复制");   // 新块带上源层名
        else if (act === "del") BF.marqueeDelete(ed._mq);
        ed._mq = null;
    });
    ed.panel.appendChild(menu);   // 挂编辑器内层：z-index 高过 overlay，且关闭编辑器时随面板一起移除（不残留）
};
// 选区所见即所得块合成：把选区内全部可见图层（原图层记选区、复制块记引用、部件记 gsrc、笔迹层记笔迹）
// 按显示顺序合成进块画布并生出重演配方。框选复制与取色取样共用同一套——取色取样因此天然等价于「全图层最前可见像素」
// 返回 null = 原图跨域读不了；否则 { piece, canvas, ok }（ok=false 表示选区内没有任何内容）
BF.assemblePiece = function(m, pick) {   // pick 缺省=全部可见层；取色取样传过滤器排除「取色涂」印章层，免配方自我嵌套
    m.w = Math.round(m.x + m.w) - Math.round(m.x); m.h = Math.round(m.y + m.h) - Math.round(m.y);   // 选区左边界吸附整纹素、右边界保持原样（宽度收掉差值，不越界）：新层生成即落在网格上，不必事后再挪
    m.x = Math.round(m.x); m.y = Math.round(m.y);
    const ed = BF.ed, o = BF.seen.get(ed.src), L0 = ed.layers[0];
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(m.w)); c.height = Math.max(1, Math.round(m.h));
    const cc = c.getContext("2d");
    cc.imageSmoothingEnabled = false;
    const piece = { x: m.x, y: m.y, s: 1, w: c.width, h: c.height, ox: m.x, oy: m.y, sx: 0, sy: 0, sw: 0, sh: 0, ink: 0 };
    let refAt = -1, inkAt = -1;   // 引用/笔迹在层序中的位置：笔迹整体高于引用时，块内笔迹须画在引用之上
    try {
        for (const L of ed.layers) {
            if (!L.visible || (pick && !pick(L))) continue;
            if (L === L0) {   // 原图层：预览画 L0 画布（含遮罩抠除），渲染源 = 原图选区
                const sx = (m.x - L0.x) / L0.s, sy = (m.y - L0.y) / L0.s, sw = m.w / L0.s, sh = m.h / L0.s;
                if (sw > 0 && sh > 0 && sx < o.naturalWidth && sy < o.naturalHeight) {
                    const cx = Math.max(0, sx), cy = Math.max(0, sy);
                    const cw = Math.min(o.naturalWidth, sx + sw) - cx, ch = Math.min(o.naturalHeight, sy + sh) - cy;
                    if (cw >= 1 && ch >= 1) { piece.sx = cx; piece.sy = cy; piece.sw = cw; piece.sh = ch; }
                }
            } else if (L.piece) {   // 其它复制块：记引用快照（深拷贝），渲染/回填/导出时递归重演
                const rp = BF.plainPiece(L.piece);
                if (L.piece.inkImg) rp.inkImg = L.piece.inkImg;   // 冻结笔迹图（Image 不可变可共享）：引用重演同步吃得到
                if (L.piece.maskCanvas) rp.maskImg = L.piece.maskCanvas;   // 遮罩运行画布共享：引用重演同步带上抠除（落库时 refs 会再纯化剥离）
                (piece.refs = piece.refs || []).push({ pc: rp, x: L.x, y: L.y, s: L.s });
                refAt = ed.layers.indexOf(L);
            } else if (L.noExport) {   // 部件参考层：记 src 引用，重演 = 该部件原图 + 自身笔迹
                (piece.refs = piece.refs || []).push({ gsrc: L.gSrc, x: L.x, y: L.y, s: L.s });
                refAt = ed.layers.indexOf(L);
            } else {   // 笔迹层：选区有像素才记（画布干净可读）；采样框按图层画布边界收缩，越界部分不扫
                const sx = Math.max(0, Math.floor((m.x - L.x) / L.s)), sy = Math.max(0, Math.floor((m.y - L.y) / L.s));
                const sw = Math.min(L.canvas.width - sx, Math.ceil((m.x + m.w - L.x) / L.s) - sx);
                const sh = Math.min(L.canvas.height - sy, Math.ceil((m.y + m.h - L.y) / L.s) - sy);
                if (sw > 0 && sh > 0) {
                    const d = L.ctx.getImageData(sx, sy, sw, sh).data;
                    for (let i = 3; i < d.length; i += 4) if (d[i]) { piece.ink = 1; if (inkAt < 0) inkAt = ed.layers.indexOf(L); break; }
                }
            }
            cc.drawImage(L.canvas, (m.x - L.x) / L.s, (m.y - L.y) / L.s, m.w / L.s, m.h / L.s, 0, 0, c.width, c.height);
        }
    } catch (e) { return null; }
    if (piece.refs && inkAt > refAt) piece.inkTop = 1;   // 笔迹在引用块之上（如笔迹层叠在复制块上）：块内先画引用再画笔迹，保持原层序
    return { piece, canvas: c, ok: !!(piece.sw || piece.ink || piece.refs) };
};
// 复制 = 「所见即所得」像素快照：把选区内所有可见图层（含笔迹、部件、其它复制块）
// 按显示顺序合成进块画布。渲染时由 renderPiece 重演（原图部分+遮罩+笔迹部分，见下）
BF.copyRect = function(m, pick, msg, name) {   // 框选复制（pick 缺省=全部可见层；「合并图层」传两层选择器）；name=新层名（带上源层名，便于区分）
    const ed = BF.ed;
    const grp = pick ? null : BF.pushUndo([]);   // 框选复制=纯新增：撤销只需删掉新层（合并由调用方自己记账，故 pick 时不记）
    const a = BF.assemblePiece(m, pick);
    if (!a) { BF.toast("复制失败：原图受浏览器安全限制"); if (grp) ed.undo.pop(); return; }
    if (!a.ok) { BF.toast("选区内没有可复制的内容"); if (grp) ed.undo.pop(); return; }
    const piece = a.piece, c = a.canvas, cc = c.getContext("2d");
    if (!piece.sw && !piece.refs) {   // 纯笔迹选区：画布干净，直接做成普通笔迹像素层——画/擦/抓全走笔迹同一套，无需块配方
        const NL = { canvas: c, ctx: cc, name: name || "笔迹", visible: true, x: m.x, y: m.y, s: 1 };
        ed.layers.push(NL);
        ed.active = ed.layers.length - 1;
        ed.tool = "move";
        BF.syncLayers(); BF.syncTools(); BF.applyLayer(NL);
        BF.toast(msg || "已复制笔迹为新图层，拖到需要的位置");
        if (grp) grp.push({ L: NL, inList: false, x: NL.x, y: NL.y, s: NL.s });   // 否定快照：撤销时删掉新层
        return NL;
    }
    if (piece.ink) {   // 块内笔迹定格：把选区内的笔迹窗冻结成 PNG（干净画布可导出）。之后笔迹改动不进块、
        const iw = document.createElement("canvas");   // 块移动不拖着笔迹跑双重成像——「复制」语义就此完整
        iw.width = c.width; iw.height = c.height;
        const ic2 = iw.getContext("2d");
        for (const L of ed.layers) {
            if (L.noExport || !L.visible || (pick && !pick(L))) continue;
            ic2.drawImage(L.canvas, (m.x - L.x) / L.s, (m.y - L.y) / L.s, m.w / L.s, m.h / L.s, 0, 0, c.width, c.height);
        }
        piece.inkURL = iw.toDataURL("image/png");
        piece.inkImg = new Image(); piece.inkImg.src = piece.inkURL;   // 同时备好内存图：块被复制/重画时 renderPiece 直接吃冻结笔迹，不必回落到「实时笔迹」——源笔迹层被合并吞掉后实时合成是空的，笔迹就丢了
    }
    const L = { canvas: c, ctx: cc, name: name || "复制块", visible: true, x: m.x, y: m.y, s: 1, noExport: true, piece };
    const at = ed.layers.findIndex(L2 => !L2.noExport);   // 插到笔迹层之下，与 composeFix 渲染顺序一致
    const idx = at < 0 ? ed.layers.length : at;
    ed.layers.splice(idx, 0, L);
    ed.active = idx;
    ed.tool = "move";   // 复制完直接切回移动工具，顺手拖到位
    let tip = msg || "已复制选区为新图层，拖到需要的位置";
    if (ed.groupMove) {   // 组合模式会连带移动全部图层（含新块）：自动退出，让块独立拖放
        ed.groupMove = false;
        ed.panel.querySelector("#bfGroupMove").classList.remove("bfActive");
        tip += "（已自动退出组合模式）";
    }
    BF.syncLayers(); BF.syncTools(); BF.applyLayer(L);
    BF.toast(tip);
    if (grp) grp.push({ L, inList: false, x: L.x, y: L.y, s: L.s });   // 否定快照：撤销时删掉新块
    return L;
};
// 复制块数据纯化：深拷贝为可序列化结构（运行画布→DataURL 冻结快照、丢 Image 等运行对象），
// 供块引用与落库/导出使用——嵌套 refs 递归纯化，建块时刻的状态就此冻结
BF.plainPiece = function(pc) {
    const o = {};
    ["x", "y", "s", "w", "h", "ox", "oy", "sx", "sy", "sw", "sh", "ink", "inkTop"].forEach(k => o[k] = pc[k] ?? 0);
    if (pc.inkURL) o.inkURL = pc.inkURL;
    if (pc.maskCanvas) { try { o.maskURL = pc.maskCanvas.toDataURL("image/png"); } catch (e) { /* 理论不可达：遮罩是干净画布 */ } }
    else if (pc.maskURL) o.maskURL = pc.maskURL;
    if (pc.crop) o.crop = { ...pc.crop };
    if (pc.refs?.length) o.refs = pc.refs.map(r => r.gsrc ? { gsrc: r.gsrc, x: r.x, y: r.y, s: r.s }
        : { pc: BF.plainPiece(r.pc), x: r.x, y: r.y, s: r.s });
    return o;
};
// 重演复制块快照：原图选区 → 擦除遮罩抠除 → 笔迹选区 → 块遮罩抠除（橡皮/框删的持久化数据）→ 引用块递归重演
// maskC：编辑器传运行时遮罩画布（撤销重画用）；渲染链不传，用 pc.maskImg（loadFix 解码的内存图）
BF.renderPiece = function(pc, orig, eraseImg, inkImg, maskC) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(pc.w)); c.height = Math.max(1, Math.round(pc.h));
    const cc = c.getContext("2d");
    cc.imageSmoothingEnabled = false;
    if (pc.sw && orig && orig.complete && orig.naturalWidth) cc.drawImage(orig, pc.sx, pc.sy, pc.sw, pc.sh, 0, 0, c.width, c.height);
    if (pc.sw && eraseImg && (eraseImg.complete === undefined || eraseImg.complete)) {
        cc.globalCompositeOperation = "destination-out";
        cc.drawImage(eraseImg, pc.ox, pc.oy, pc.w, pc.h, 0, 0, c.width, c.height);
        cc.globalCompositeOperation = "source-over";
    }
    const inkSrc = pc.inkImg ?? (pc.ink ? inkImg : null);   // 冻结的笔迹窗优先（复制=建块时刻定格）；旧数据无 inkURL 回退实时合成
    const drawInk = () => { if (inkSrc && (inkSrc.complete === undefined || inkSrc.complete)) cc.drawImage(inkSrc, pc.ox, pc.oy, pc.w, pc.h, 0, 0, c.width, c.height); };
    if (!pc.inkTop) drawInk();   // 默认块内层序：笔迹在引用块之下
    let mk = maskC || pc.maskImg;
    if (!mk && pc.maskURL) {   // 引用块只带纯数据遮罩：惰性解码缓存，完成后全量补刷（本次先不抠，下次渲染自然带上）
        pc.maskImg = new Image();
        pc.maskImg.onload = () => BF.refresh();
        pc.maskImg.src = pc.maskURL;
    }
    for (const rf of pc.refs || []) {   // 引用块：其它复制块递归重演 / 组合部件按原图+自身笔迹重演，画在建块时刻的位置
        let sc = null;
        if (rf.gsrc) {
            const gi = BF.seen.get(rf.gsrc), gf = BF.store.get(rf.gsrc);
            if (gi?.complete && gi.naturalWidth) {
                sc = document.createElement("canvas");
                sc.width = gi.naturalWidth; sc.height = gi.naturalHeight;
                const s2 = sc.getContext("2d");
                s2.drawImage(gi, 0, 0);
                if (gf?.img && (gf.img.complete === undefined || gf.img.complete)) s2.drawImage(gf.img, 0, 0);
            }
        } else sc = BF.renderPiece(rf.pc, orig, eraseImg, inkImg);
        if (sc) cc.drawImage(sc, rf.x - pc.ox, rf.y - pc.oy, sc.width * rf.s, sc.height * rf.s);
    }
    if (pc.inkTop) drawInk();   // 合并自「笔迹在上、块在下」：引用先画，笔迹后画
    mk = maskC || pc.maskImg;   // 遮罩必须最后应用：把整块内容（含引用块重演）一起抠掉——引用内容若在遮罩后画会把擦除重新盖回来（块套块擦除失效的根因）
    if (mk && (mk.complete === undefined || mk.complete)) {
        cc.globalCompositeOperation = "destination-out";
        cc.drawImage(mk, 0, 0, c.width, c.height);
        cc.globalCompositeOperation = "source-over";
    }
    return c;
};
// 笔迹快照合成：全部可见笔迹层实时合成一张（建块 / 块重画用，与 saveFix 导出合成同源：
// 建块后新画的笔迹渲染时同样进块）
BF.inkSnap = function() {
    const ed = BF.ed;
    const ink = document.createElement("canvas");
    ink.width = ed.fileW; ink.height = ed.fileH;
    const ic = ink.getContext("2d");
    ed.layers.forEach(x => { if (!x.noExport && x.visible) ic.drawImage(x.canvas, x.x, x.y, x.canvas.width * x.s, x.canvas.height * x.s); });   // 尺寸按各自画布：紧致后的笔迹层不再被拉伸回整张原图大小
    return ink;
};
// 复制块全量重画（撤销/还原块遮罩后调用）：块画布被污染改不了像素，只能 renderPiece 重演再整体替换
BF.redrawPiece = function(L) {
    const ed = BF.ed;
    if (!ed?.layers.includes(L)) return;
    L.ctx.globalCompositeOperation = "source-over";
    L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
    L.ctx.drawImage(BF.renderPiece(L.piece, BF.seen.get(ed.src), ed.erase, BF.inkSnap(), L.piece.maskCanvas), 0, 0);
    BF.renderStage();
};
// 删除选区：笔迹层按变换反推清矩形，原图部分由遮罩盖掉（橡皮同款机制）；
// 复制块与笔迹层同款——选区内部分抠除（记进块遮罩，可撤销、保存后生效），不再整块移除
BF.marqueeDelete = function(m) {
    const ed = BF.ed;
    const hit = L2 => {   // 选区与块的相交检测（块坐标换算）
        const w = L2.canvas.width * L2.s, h = L2.canvas.height * L2.s;
        return L2.x < m.x + m.w && m.x < L2.x + w && L2.y < m.y + m.h && m.y < L2.y + h;
    };
    for (const L2 of ed.layers) {   // 先给会被抠除的块惰性建遮罩：快照必须覆盖到它，撤销才有依据
        if (L2.piece && L2.visible && hit(L2) && !L2.piece.maskCanvas) {
            L2.piece.maskCanvas = document.createElement("canvas");
            L2.piece.maskCanvas.width = L2.canvas.width; L2.piece.maskCanvas.height = L2.canvas.height;
        }
    }
    BF.pushUndo([...ed.layers.filter(L2 => !L2.noExport || L2.piece?.maskCanvas), { canvas: ed.erase, ctx: ed.eraseCtx, x: 0, y: 0, s: 1 }]);
    ed.eraseDirty = true;
    for (let i = ed.layers.length - 1; i >= 0; i--) {
        const L2 = ed.layers[i];
        if (L2 === ed.layers[0] || !L2.visible) continue;   // 原图层走遮罩
        if (L2.piece) {   // 复制块：选区内部分抠除（遮罩记档 + 块画布即时清显）
            const px = Math.max(0, (m.x - L2.x) / L2.s), py = Math.max(0, (m.y - L2.y) / L2.s);
            const pw = Math.min(L2.canvas.width - px, (m.x + m.w - L2.x) / L2.s - px);
            const ph = Math.min(L2.canvas.height - py, (m.y + m.h - L2.y) / L2.s - py);
            if (pw > 0 && ph > 0) {
                const mc = L2.piece.maskCanvas.getContext("2d");
                mc.fillStyle = "#000";
                mc.fillRect(px, py, pw, ph);
                L2.ctx.clearRect(px, py, pw, ph);
                L2.pmDirty = true;
            }
            continue;
        }
        L2.ctx.clearRect((m.x - L2.x) / L2.s, (m.y - L2.y) / L2.s, m.w / L2.s, m.h / L2.s);
        L2._bndsDirty = true;   // 内容变了：紧致边框缓存失效
    }
    ed.eraseCtx.fillStyle = "#000";
    ed.eraseCtx.fillRect(m.x, m.y, m.w, m.h);
    ed.active = Math.max(0, Math.min(ed.active, ed.layers.length - 1));
    BF.redrawBase(); BF.syncLayers(); BF.syncTools();
    BF.toast("已删除选区内容");
};

/* ---------- 图层操作 ---------- */
BF.addLayer = function() {
    const ed = BF.ed;
    const L = { canvas: document.createElement("canvas"), name: `图层${ed.layers.length}`,
                visible: true, x: 0, y: 0, s: 1 };
    L.canvas.width = ed.fileW; L.canvas.height = ed.fileH;
    L.ctx = L.canvas.getContext("2d");
    ed.layers.push(L);
    ed.active = ed.layers.length - 1;
    BF.syncLayers(); BF.syncTools();
};
BF.mergeLayer = function() {   // 合并图层（更多工具）：当前层与下一层（图层条右侧相邻、z 更低）合成一个块
    const ed = BF.ed, i = ed.active, L = ed.layers[i], N = ed.layers[i - 1];
    if (!L || L.locked) { BF.toast("请选择笔迹或复制块图层"); return; }
    if (!N) { BF.toast("当前图层右侧没有图层了"); return; }
    if (N.locked) { BF.toast("下一图层是原图层，不能合并；可用「分割工具」拆分原图"); return; }
    if (!L.visible || !N.visible) { BF.toast("先显示要合并的两个图层"); return; }
    const rx = T => { const b = BF.layerBounds(T) || { x: 0, y: 0, w: T.canvas.width, h: T.canvas.height };   // 用各层内容紧致框算联合范围：笔迹层画布是整张原图大小，直接取画布会把合并块撑成全宽高
        return [T.x + b.x * T.s, T.y + b.y * T.s, T.x + (b.x + b.w) * T.s, T.y + (b.y + b.h) * T.s]; };
    const a = rx(L), b = rx(N);   // 两层联合包围盒（舞台坐标）= 合并块的覆盖范围
    const grp = BF.pushUndo([L, N]);   // 先记两层快照：撤销可双双插回
    const NL = BF.copyRect({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
                             w: Math.max(a[2], b[2]) - Math.min(a[0], b[0]),
                             h: Math.max(a[3], b[3]) - Math.min(a[1], b[1]) },
                           T => T === L || T === N, "已合并为一个块", L.name + "+" + N.name);   // 合并块名=两层源名
    if (!NL) { ed.undo.pop(); return; }   // 合并落空（空层等）：撤销不留痕
    grp.push({ L: NL, inList: false, x: NL.x, y: NL.y, s: NL.s });   // 否定快照：撤销时把新建层一并移除
    ed.layers.splice(ed.layers.indexOf(L), 1);
    ed.layers.splice(ed.layers.indexOf(N), 1);   // 摘掉两层（块已由 copyRect 插入）
    ed.active = ed.layers.indexOf(NL);
    BF.syncLayers(); BF.renderStage();
};
BF.dupLayer = function() {   // 复制当前图层（更多工具）：笔迹层直拷像素；复制块克隆配方并另拷遮罩（互不影响）
    const ed = BF.ed, L = ed.layers[ed.active];
    if (L.locked) { BF.toast("原图层不能复制，可用「分割工具」拆分"); return; }
    const NL = { name: L.name + " 副本", visible: true, x: L.x, y: L.y, s: L.s };
    const grp = BF.pushUndo([]);   // 复制=纯新增：撤销只需删掉副本（空组稍后塞否定快照）
    if (L.piece) {
        NL.noExport = true;
        NL.crop = L.crop ? { ...L.crop } : undefined;   // 裁剪框跟着副本走：分割过/裁过的块复制后才仍是自己那一侧，不会又变回全宽高（笔迹层的紧致靠像素直拷后的 BF.tighten，不要带框）
        const pc = { ...L.piece };
        pc.refs = pc.refs?.map(r => r.gsrc ? { ...r } : { ...r, pc: BF.plainPiece(r.pc) });   // 引用链克隆（同 saveFix 落库同款）
        if (L.piece.maskCanvas) {
            const m = document.createElement("canvas"); m.width = L.canvas.width; m.height = L.canvas.height;
            m.getContext("2d").drawImage(L.piece.maskCanvas, 0, 0);
            pc.maskCanvas = m;
        }
        NL.piece = pc;
        NL.pmDirty = !pc.maskURL;   // 父块遮罩已有导出档则沿用（内容相同）；没有就必须导出，否则副本的擦除不落库
        const c = BF.renderPiece(pc, BF.seen.get(ed.src), ed.erase, BF.inkSnap(), pc.maskCanvas);
        NL.canvas = c; NL.ctx = c.getContext("2d");
    } else {   // 笔迹层：干净画布，像素直拷后裁到内容框（不再拖一张整图大小的空白画布）
        const c = document.createElement("canvas"); c.width = L.canvas.width; c.height = L.canvas.height;
        c.getContext("2d").drawImage(L.canvas, 0, 0);
        NL.canvas = c; NL.ctx = c.getContext("2d");
        BF.tighten(NL);
    }
    ed.layers.splice(ed.layers.indexOf(L) + 1, 0, NL);
    ed.active = ed.layers.indexOf(NL);
    ed.tool = "move";   // 复制完通常就要挪位置：自动切到移动工具
    grp.push({ L: NL, inList: false, x: NL.x, y: NL.y, s: NL.s });   // 否定快照：撤销时删掉副本
    BF.syncLayers(); BF.syncTools();
    BF.renderStage();
};
BF.delLayer = function(L) {   // 删除指定图层（图层条 ✕ 按钮）；原图层锁定保护
    const ed = BF.ed;
    if (L.locked) { BF.toast("原图层不能删除，可用「还原」整体复原"); return; }
    if (ed.layers.length <= 1) return;
    const i = ed.layers.indexOf(L);
    BF.pushUndo(L);   // 先记快照（含原位序）：✕ 删除后可按撤销把图层插回
    ed.layers.splice(i, 1);
    if (ed.active >= i) ed.active = Math.min(Math.max(ed.active - 1, 0), ed.layers.length - 1);
    BF.syncLayers(); BF.syncTools();
};
// 对齐滑杆统一入口：连续拖动只记一次撤销（600ms 防抖）
BF.setLayer = function(attr, v) {
    const ed = BF.ed, L = ed.layers[ed.active];
    const multi = attr === "s" && ed._scaleSel?.length > 1;
    if (L._sliderUndo !== true) { BF.pushUndo(multi ? ed._scaleSel : L); L._sliderUndo = true; setTimeout(() => delete L._sliderUndo, 600); }
    if (attr === "s") {
        const anch = T => {   // 锚点 = 可见边框（内容紧致框）的左上角：画布左上角定住的话，内容不在原点的层一缩放就朝反方向漂
            const b = BF.layerBounds(T);
            const px = b ? b.x : 0, py = b ? b.y : 0;
            T.x = Math.round(T.x - px * (v - T.s));
            T.y = Math.round(T.y - py * (v - T.s));
        };
        if (multi) {   // 缩放列表整体按同一比值缩放（各层钳制 25%~400%，各自以自己的边框左上角为锚）
            const r = v / L.s;
            for (const S of ed._scaleSel) if (S !== L) {
                S.s = Math.min(4, Math.max(0.25, S.s * r));
                anch(S);
                BF.applyLayer(S);
            }
        }
        anch(L);
        L.s = v;   // 缩放时左上角吸附纹素边界；整数倍档下所有纹素边界随之全落在网格线上
    } else L[attr] = v;
    BF.applyLayer(L);
    BF.renderStage();
};
// 裁剪落定：把裁剪框外的内容抠掉，各层写进各自的持久化通道，然后清掉预览字段。
//   笔迹层 → 直接 destination-out 本层画布（随笔迹 PNG 导出）；
//   复制块 → 块画布同步抠显，块遮罩填黑框外（保存依据；块画布被原图污染读不了像素，只能靠遮罩）；
//   原图层 → 抠除记入全局擦除遮罩（合成坐标，原图画布不动，与橡皮同款机制）
BF.bakeCrop = function(L) {
    const ed = BF.ed, c = L.crop, W = L.canvas.width, H = L.canvas.height;
    const cw = Math.max(1, W - c.l - c.r), ch = Math.max(1, H - c.t - c.b);
    const punch = (ctx, x0, y0, w0, h0) => {   // 在指定矩形四边外补满（遮罩要「黑」= 抠除，故用 source-over 填黑；显示画布用 destination-out 抹）
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 1; ctx.fillStyle = "#000";   // 满不透明才抠得干净（复用的上下文可能残留半透明/浅色）
        ctx.fillRect(0, 0, W, y0); ctx.fillRect(0, y0 + h0, W, H - y0 - h0);
        ctx.fillRect(0, y0, x0, h0); ctx.fillRect(x0 + w0, y0, W - x0 - w0, h0);
        ctx.globalCompositeOperation = "source-over";
    };
    if (L.piece) {   // 复制块：遮罩（黑=抠除）填满框外 + 本层画布即时抠显
        if (!L.piece.maskCanvas) { L.piece.maskCanvas = document.createElement("canvas"); L.piece.maskCanvas.width = W; L.piece.maskCanvas.height = H; }
        const mc = L.piece.maskCanvas.getContext("2d");
        mc.globalCompositeOperation = "source-over"; mc.globalAlpha = 1; mc.fillStyle = "#000";
        mc.fillRect(0, 0, W, c.t); mc.fillRect(0, c.t + ch, W, H - c.t - ch);
        mc.fillRect(0, c.t, c.l, ch); mc.fillRect(c.l + cw, c.t, W - c.l - cw, ch);
        punch(L.ctx, c.l, c.t, cw, ch);
        L.pmDirty = true;
    } else if (L === ed.layers[0]) {   // 原图层：合成坐标下填黑框外（遮罩由 redrawBase 反推回原图坐标）
        const x = L.x + c.l * L.s, y = L.y + c.t * L.s, w = cw * L.s, h = ch * L.s;
        ed.eraseCtx.globalCompositeOperation = "source-over";
        ed.eraseCtx.globalAlpha = 1; ed.eraseCtx.fillStyle = "#000";
        ed.eraseCtx.fillRect(0, 0, ed.fileW, y); ed.eraseCtx.fillRect(0, y + h, ed.fileW, ed.fileH - y - h);
        ed.eraseCtx.fillRect(0, y, x, h); ed.eraseCtx.fillRect(x + w, y, ed.fileW - x - w, h);
        ed.eraseDirty = true;
        BF.redrawBase();
    } else punch(L.ctx, c.l, c.t, cw, ch);
    // 复制块/原图层的紧致边框读不出像素，保留裁剪框当可视范围标记；笔迹层抠完像素后紧致框自然贴合，无需保留
    if (!L.piece && L !== ed.layers[0]) delete L.crop;
    L._bndsDirty = true;
};
// 缩放确认（与复制同款收场）：位置取整到纹素边界；笔迹层把当前缩放定格成像素
//（画布重制为缩放后尺寸、s 复位 100%，所见即所存）；原图层/复制块的缩放本就随配方持久化，只取整位置
BF.scaleConfirm = function() {
    const ed = BF.ed;
    for (const L of ed._scaleSel?.length ? ed._scaleSel : [ed.layers[ed.active]]) {   // 缩放列表整表确认
        if (L.crop) BF.bakeCrop(L);   // ✓ 确认裁剪：框外内容抠掉并落进各自的持久化通道
        if (!L.noExport && !L.piece && L !== ed.layers[0]) {
            BF.pushUndo(L);
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(L.canvas.width * L.s)); c.height = Math.max(1, Math.round(L.canvas.height * L.s));
            const cc = c.getContext("2d");
            cc.imageSmoothingEnabled = false;
            cc.drawImage(L.canvas, 0, 0, c.width, c.height);
            L.canvas = c; L.ctx = cc; L.s = 1; L._bndsDirty = true;
        }
        L.x = Math.round(L.x); L.y = Math.round(L.y);
        BF.applyLayer(L);
    }
    BF.renderStage();
};
BF.applyLayer = function(L) {
    // 位置/缩放只存数据，显示由 renderStage 统一绘制（不再操作 DOM）；这里只同步面板数值
    const ed = BF.ed;
    if (L === ed.layers[0]) {   // 原图层一动，擦除遮罩必须整体跟着变换：遮罩锚定在原图内容上（m'=(m-x0)*s/s0+x1），
        const t = L._etf;        // 否则「擦完再移动/缩放」洞会留在原地——编辑器一重画就露馅，存档与游戏侧同样错位
        if (!t) L._etf = { x: L.x, y: L.y, s: L.s };
        else if (t.x !== L.x || t.y !== L.y || t.s !== L.s) {
            const r = L.s / t.s, c = document.createElement("canvas");
            c.width = ed.fileW; c.height = ed.fileH;
            c.getContext("2d").drawImage(ed.erase, 0, 0);
            const q = Math.abs(r - 1) < 1e-9;   // 纯平移取整位移：遮罩硬边不被反复重采样糊掉（拖动过程按帧调用）
            const nx = q ? t.x + Math.round(L.x - t.x) : L.x, ny = q ? t.y + Math.round(L.y - t.y) : L.y;
            ed.eraseCtx.globalCompositeOperation = "source-over"; ed.eraseCtx.globalAlpha = 1;
            ed.eraseCtx.imageSmoothingEnabled = false;
            ed.eraseCtx.clearRect(0, 0, ed.fileW, ed.fileH);
            ed.eraseCtx.drawImage(c, nx - t.x * r, ny - t.y * r, ed.fileW * r, ed.fileH * r);
            L._etf = { x: nx, y: ny, s: L.s };
            if (ed.eraseDirty || BF.store.get(ed.src)?.eraseURL) ed.eraseDirty = true;   // 遮罩内容变了：保存时重新导出（本来没有洞就不凭空造一张空遮罩）
        }
    }
    if (ed.panel && L === ed.layers[ed.active]) {   // 对齐数值跟随当前层（拖动/撤销/还原都会同步到这里）
        ed.panel.querySelector("#bfLXV").textContent = Math.round(L.x);
        ed.panel.querySelector("#bfLYV").textContent = Math.round(L.y);
        ed.panel.querySelector("#bfLayerScale").value = Math.round(L.s * 100);
        const pct = Math.round(L.s * 100) + "%";
        ed.panel.querySelector("#bfScaleV2").textContent = pct;
    }
};
BF.syncTools = function(keep) {   // 统一禁用入口：keep = 要保持可用的按钮选择器数组（其余工具按钮一律灰掉）；缺省按当前模式自动判断
    const ed = BF.ed;
    if (keep === undefined) keep = ed._scaleMode ? ["#bfScaleBtn"] : ed.pickSrc !== undefined ? ["#bfPick"] : [];   // 缩放中只留缩放键、取色中只留取色键：两个模式互斥且能再点自己关掉
    ed.panel.querySelectorAll(".bfTool, #bfScaleBtn, #bfPick, #bfDupLayer, #bfMergeLayer").forEach(b => {
        if (b.dataset.tool) b.classList.toggle("bfActive", b.dataset.tool === ed.tool);   // 只有工具键跟 ed.tool 联动高亮；缩放/取色键的亮灭由各自开关管
        b.disabled = !!keep.length && !keep.some(k => b.matches(k));
    });
    ed.panel.querySelector("#bfSplitBox").classList.toggle("bfHide", ed.tool !== "split");   // 分割提示条随工具显隐（含取消按钮，样式同复像控制器）
    if (ed.tool !== "split") ed.splitAll = false;   // 离开分割模式即关掉「全图切割」，避免下次进来是亮的却没生效
    ed.panel.querySelector("#bfSplitAll").classList.toggle("bfActive", !!ed.splitAll);
    if (ed.cursorEl) ed.cursorEl.style.display = "none";   // 切工具后光标圈等下次移动再按新工具显隐
};

// 图层列表面板
// 图层内容边界（层画布坐标）：笔迹层扫 alpha 求紧致框（缓存，_bndsDirty 失效重算）；
// 复制块/原图层画布被污染读不了像素 → 按整块画布。返回 null = 笔迹层为空（列表显示斜纹）
BF.layerBounds = function(L) {
    if (L.crop) { const c = L.crop; return { x: c.l, y: c.t, w: Math.max(1, L.canvas.width - c.l - c.r), h: Math.max(1, L.canvas.height - c.t - c.b) }; }   // 裁剪调节中：以裁剪框为准（给四条边手柄定位）
    if (L.piece || L.locked) return { x: 0, y: 0, w: L.canvas.width, h: L.canvas.height };
    if (L._bnds === undefined || L._bndsDirty) {
        L._bndsDirty = false;
        let b = null;
        try {
            const dd = L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height).data, w = L.canvas.width;
            for (let y = 0, i = 3; y < L.canvas.height; y++) {
                for (let x = 0; x < w; x++, i += 4) {
                    if (!dd[i]) continue;
                    if (!b) b = { x0: x, y0: y, x1: x, y1: y };
                    else {
                        if (x < b.x0) b.x0 = x;
                        if (x > b.x1) b.x1 = x;
                        if (y > b.y1) b.y1 = y;
                    }
                }
            }
        } catch (e) { /* 污染降级：按整块 */ }
        L._bnds = b ? { x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 } : null;
    }
    return L._bnds;
};
// 笔迹层裁到内容紧致框（去四周空白）并把画布平移对齐：复制/分割后不再拖着整张原图大小的空白画布
// （复制块与参考层的画布读不出像素，紧致框不可得，原样返回；空层同样不动）
BF.tighten = function(L) {
    if (L.piece || L.noExport || L.crop) return L;
    const b = BF.layerBounds(L);
    if (!b || (b.x === 0 && b.y === 0 && b.w === L.canvas.width && b.h === L.canvas.height)) return L;
    const c = document.createElement("canvas");
    c.width = b.w; c.height = b.h;
    c.getContext("2d").drawImage(L.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    L.canvas = c; L.ctx = c.getContext("2d");
    L.x += b.x * L.s; L.y += b.y * L.s;
    L._bndsDirty = true;
    return L;
};
BF.syncLayers = function() {
    const ed = BF.ed;
    const box = ed.panel.querySelector("#bfLayers");
    box.innerHTML = "";
    const add = BF.h(`<div class="bfLayerRow bfLayerAdd" title="新建笔迹图层">＋</div>`);   // 队首 + 片：新建图层
    add.addEventListener("click", BF.addLayer);
    box.appendChild(add);
    for (let i = ed.layers.length - 1; i >= 0; i--) {
        const L = ed.layers[i];
        const mvTile = (dir, tip, ch) => {   // 选中层两侧的移层小片（同选中层高亮样式）
            const t = BF.h(`<div class="bfLayerRow bfLayerAdd bfActive" title="${tip}">${ch}</div>`);
            t.addEventListener("click", () => BF.moveLayerBy(L, dir));
            return t;
        };
        const row = BF.h(`
            <div class="bfLayerRow ${ed._scaleSel ? (ed._scaleSel.includes(L) ? "bfActive" : "") : i === ed.active ? "bfActive" : ""}${BF.layerBounds(L) === null ? " bfEmptyLayer" : ""}">
                <button class="bfEye" title="显示/隐藏">${L.visible ? "▣" : "▢"}</button>
                <span class="bfLayerName" title="双击重命名">${L.gSrc ? "<span style='color: var(--gold);'>配件</span> " : ""}${L.name}${L.locked ? " <span style='color: var(--500);'>锁定</span>" : ""}</span>
                ${i && !L.locked ? `<button class="bfEye bfDel" title="删除图层">✕</button>` : ""}
            </div>`);
        row._layer = L;
        row.addEventListener("click", e => {
            if (e.target.classList.contains("bfDel")) { BF.delLayer(L); return; }
            if (e.target.classList.contains("bfEye")) { L.visible = !L.visible; }
            else if (ed._scaleMode) {   // 缩放调节中：点图层片 = 加入缩放列表 / 再点移出（高亮=在列）
                const k = ed._scaleSel.indexOf(L);
                if (k >= 0) ed._scaleSel.splice(k, 1);
                else { L._s0 = { x: L.x, y: L.y, s: L.s, crop: L.crop ? { ...L.crop } : null }; ed._scaleSel.push(L); }
                const tag = ed.panel.querySelector("#bfScaleTag");
                tag.textContent = "多选：" + ed._scaleSel.length + "图层";
                tag.classList.toggle("bfHide", ed._scaleSel.length <= 1);
            }
            else if (ed.active !== i) ed.active = i;   // 取色块不因换图层关闭（取的是全图层所见，跟选中层无关）
            BF.updateVis(); BF.syncLayers(); BF.syncTools();
        });
        row.querySelector(".bfLayerName").addEventListener("dblclick", e => {   // 双击重命名（模态输入框，iOS 可用）
            e.stopPropagation();
            BF.prompt("图层名称", L.name, n => { L.name = n; BF.syncLayers(); });
        });
        if (i) row.addEventListener("pointerdown", e => BF.dragLayer(row, L, e));   // 原图层固定不动
        if (i === ed.active && i > 0 && i < ed.layers.length - 1) box.appendChild(mvTile(1, "上移一层（顶层）", "‹"));   // 到顶不显示 ‹
        box.appendChild(row);
        if (i === ed.active && i > 1) box.appendChild(mvTile(-1, "下移一层（底层，原图层之上）", "›"));   // 到底不显示 ›
    }
    ed.layers.forEach(L => BF.applyLayer(L));
    BF.renderStage();
};
// 拖拽排序（仅鼠标）：按住图层片横向拖，拖动中只浮动不换位（无突进）；松手按片中心与其余片
// 中心比较一次落位，且必插在原图层片之前——图层永远不会跑到原图层后面。触屏走 ‹ › 按钮
BF.dragLayer = function(row, L, e) {
    if (e.pointerType !== "mouse" || e.button !== 0 || e.target.closest(".bfEye")) return;
    const ed = BF.ed, strip = row.parentElement;
    const sx = e.clientX;
    let moved = false;
    const mv = ev => {
        const dx = ev.clientX - sx;
        if (!moved && Math.abs(dx) < 6) return;   // 死区：保留 click/双击
        if (!moved) { moved = true; row.setPointerCapture(ev.pointerId); row.style.zIndex = 1; }
        row.style.transform = `translateX(${dx}px)`;
    };
    const up = () => {
        removeEventListener("pointermove", mv);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        const rc = row.getBoundingClientRect();   // 先量浮动位置（清 transform 前）
        row.style.transform = row.style.zIndex = "";
        if (!moved) return;   // 没拖动：click 正常激活
        const kill = ev => { ev.stopPropagation(); removeEventListener("click", kill, true); };   // 吃掉拖拽落点误触的 click
        addEventListener("click", kill, true);
        const others = [...strip.children].filter(c => c !== row);   // 现 DOM 序（左=顶层），含 + 片与原图层片
        const c0 = rc.left + rc.width / 2;
        let at = others.length - 1;   // 默认贴着原图层片左侧落位（原图层永远是最后一个 DOM 子元素）
        for (let i = 0; i < others.length; i++) {
            const r = others[i].getBoundingClientRect();
            if (c0 < r.left + r.width / 2) { at = i; break; }   // 插到中心在拖动片右侧的首片之前
        }
        others.splice(at, 0, row);
        ed.layers = others.filter(c => c._layer).map(c => c._layer).reverse();   // 左→右 = 顶→底，反转
        ed.active = Math.max(0, ed.layers.indexOf(L));
        BF.syncLayers(); BF.syncTools();
    };
    addEventListener("pointermove", mv);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
};
// ‹ › 按钮移层：dir +1 = 朝顶层（左）/ −1 = 朝底层（右）；原图层（索引 0）不可越过
BF.moveLayerBy = function(L, dir) {
    const ed = BF.ed, i = ed.layers.indexOf(L), j = i + dir;
    if (i < 1 || j < 1 || j >= ed.layers.length) return;
    [ed.layers[i], ed.layers[j]] = [ed.layers[j], ed.layers[i]];
    ed.active = j;   // 选择跟随被移动的层
    BF.syncLayers();
};
BF.updateVis = function() {
    BF.renderStage();
};

/* ---------- 撤销 / 重做 ---------- */
// 撤销条目 = 一次快照数组（单层操作是 [L]，组合移动是全部图层）——整组一步撤销/重做
BF.pushUndo = function(list) {
    if (!Array.isArray(list)) list = [list];
    const grp = list.map(BF.snapshot);
    BF.ed.undo.push(grp);
    if (BF.ed.undo.length > BF.MAX_UNDO) BF.ed.undo.shift();
    BF.ed.redo.length = 0;
    BF.ed.dirty = true;   // 本次打开后有改动（退出时提醒未保存；保存后清零）
    return grp;   // 「合并图层」要往同一撤销组追加新建层的否定快照
};
BF.undo = function() {
    if (!BF.ed) return;
    const ed = BF.ed, grp = ed.undo.pop();
    if (!grp) return;
    ed.redo.push(grp.map(a => BF.snapshot(a.L)));   // 必须赶在 applySnap 之前抓：此刻才是「操作后」的图层存亡/像素，重做才有东西可还原（图层增删尤其如此）
    grp.forEach(BF.applySnap);
    BF.redrawBase();   // 撤销可能回退了擦除遮罩，原图层预览随之刷新
    BF.toast("已撤销");
};
BF.redo = function() {
    if (!BF.ed) return;
    const ed = BF.ed, grp = ed.redo.pop();
    if (!grp) return;
    ed.undo.push(grp.map(a => BF.snapshot(a.L)));   // 同上：先抓「重做前」的状态，撤销才有东西可还原
    grp.forEach(BF.applySnap);
    BF.redrawBase();
    BF.toast("已重做");
};
// 原图层预览重画 = 原图 + 擦除遮罩（橡皮/撤销/还原后调用；污染画布只写不读，destination-out 合法）
BF.redrawBase = function() {
    const ed = BF.ed, L0 = ed.layers[0], o = BF.seen.get(ed.src);
    L0.ctx.globalCompositeOperation = "source-over";
    L0.ctx.clearRect(0, 0, ed.fileW, ed.fileH);
    if (o && o.complete) L0.ctx.drawImage(o, 0, 0);
    L0.ctx.globalCompositeOperation = "destination-out";
    L0.ctx.drawImage(ed.erase, -L0.x / L0.s, -L0.y / L0.s, ed.fileW / L0.s, ed.fileH / L0.s);   // 遮罩是合成坐标，按原图层的移动/缩放反推回原图坐标
    L0.ctx.globalCompositeOperation = "source-over";
    // 复制块画布 = 建块时刻的静态像素快照，这里不重画（回填/渲染时由 renderPiece 重演）
    BF.renderStage();
};
BF.snapshot = function(L) {
    let data = null, pm = null;
    if (L.piece?.maskCanvas) {   // 复制块：块画布污染读不出像素，快照块遮罩（干净画布）——恢复后全量重画
        pm = L.piece.maskCanvas;
        try { data = pm.getContext("2d").getImageData(0, 0, pm.width, pm.height); }
        catch (e) { /* 跨域污染降级 */ }
    } else if (!L.noExport) {   // 原图层（污染源）读不出像素，快照只含位置/缩放；按画布实际尺寸读（缩放定格后画布会变大）
        try { data = L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height); }
        catch (e) { /* 跨域污染降级 */ }
    }
    return { L, data, pm, x: L.x, y: L.y, s: L.s, wc: L.canvas.width, hc: L.canvas.height, vis: L.visible,
             rf: L.piece?.stamp ? L.piece.refs.slice() : undefined,   // 取色涂：印章配方副本进快照，撤销/重做整组换回（只存数量的话重做撑长数组会留空洞）
             i: BF.ed.layers.indexOf(L), inList: BF.ed.layers.includes(L), crop: L.crop ? { ...L.crop } : null };   // 记住所在位置/是否在列表/显隐/裁剪框：删除可插回、分割撤销可还原显隐、裁剪可撤销
};
BF.applySnap = function(a) {
    const layers = BF.ed.layers;
    let at = layers.indexOf(a.L), chg = false;
    if (a.inList && at < 0) { layers.splice(a.i < 0 ? layers.length : Math.min(a.i, layers.length), 0, a.L); chg = true; }   // 撤销删除：插回原位
    else if (a.inList === false && at >= 0) { layers.splice(at, 1); chg = true; }   // 重做删除：再次移除
    if (a.wc && (a.L.canvas.width !== a.wc || a.L.canvas.height !== a.hc)) {   // 缩放定格换过画布：按快照尺寸重建，否则像素放不回去
        const c = document.createElement("canvas");
        c.width = a.wc; c.height = a.hc;
        a.L.canvas = c; a.L.ctx = c.getContext("2d");
    }
    if (a.data) {
        if (a.pm) { a.pm.getContext("2d").putImageData(a.data, 0, 0); BF.redrawPiece(a.L); }   // 遮罩恢复后块重演重画（见 redrawPiece）
        else a.L.ctx.putImageData(a.data, 0, 0);
    }
    if (a.rf !== undefined) { a.L.piece.refs = a.rf; BF.redrawPiece(a.L); }   // 取色涂：印章配方整组换回，撤销/重做都精确还原
    a.L.x = a.x; a.L.y = a.y; a.L.s = a.s; a.L._bndsDirty = true;
    if (a.vis !== undefined) a.L.visible = a.vis;   // 显隐随快照回退（原图层分割藏了 L0，撤销要显回来）；合并/分割的否定快照无此字段，不覆盖
    if (a.crop) a.L.crop = { ...a.crop }; else delete a.L.crop;   // 裁剪框随快照回退
    BF.applyLayer(a.L);
    if (chg) {   // 图层被插回/移除：重建图层条并修正选中项
        BF.ed.active = Math.max(0, Math.min(BF.ed.active, layers.length - 1));
        BF.syncLayers();
    }
};

/* ---------- 保存 / 还原 ---------- */
// 只导出玩家笔迹（不含原图像素 → 永不跨域污染，file:// 也能保存）；
// 原图层的位置/缩放存进 tf，渲染时由 composeFix 现场把「原图 + 笔迹」拼成最终图
BF.saveFix = function() {
    const ed = BF.ed;
    const pend = ed.layers.find(L => L.crop);
    if (pend) BF.bakeCrop(pend);   // 带着未确认的裁剪直接保存：先落定，保证画布所见与落库一致
    const out = document.createElement("canvas");
    out.width = ed.fileW; out.height = ed.fileH;
    const ctx = out.getContext("2d");
    ed.layers.forEach(L => {
        if (!L.visible || L.noExport) return;
        ctx.drawImage(L.canvas, L.x, L.y, L.canvas.width * L.s, L.canvas.height * L.s);   // 同上：按层自身画布尺寸合成，紧致画布不会被拉伸
    });
    let dataURL;
    try { dataURL = out.toDataURL("image/png"); }
    catch (e) { BF.toast("保存失败：笔迹层意外被污染（请截图反馈作者）"); return; }
    // 擦除遮罩（干净画布，只含橡皮笔段）：本次擦过才重导出；没擦则沿用旧地址（重开编辑器时 eraseDirty 恒为 false，若此处留空会把已有擦除整条丢掉）
    const eraseURL = ed.eraseDirty ? ed.erase.toDataURL("image/png") : BF.store.get(ed.src)?.eraseURL;
    // 复制块：源区域+位置/缩放+块遮罩（橡皮/框删的抠除档）。落库版剥离运行对象（画布/Image 进不了 IndexedDB），
    // 内存版带解码好的 maskImg 供同步接管立即渲染；本次擦过的块重新导出遮罩 PNG
    const pieces = [], memPieces = [];
    ed.layers.forEach(L => {
        if (!L.piece || L.gSrc) return;   // 组合配件层的配方属于该配件自己的修正，不能写进主文件（否则游戏里会用主原图重演，变成一堆「主图纹理」的复制块）
        const pc = { ...L.piece, x: L.x, y: L.y, s: L.s, name: L.name };   // 名字随配方落库（重开时按它还原，否则一律变「复制块」、分割方位后缀丢失）
        if (L.crop) pc.crop = { ...L.crop };   // 裁剪框随配方落库（只作重开时的可视范围标记；像素已由块遮罩抠除）
        delete pc.maskCanvas; delete pc.maskImg; delete pc.inkImg;   // 运行对象不可克隆，落库前剥离（inkURL/maskURL 字符串随 spread 保留）
        if (pc.refs) pc.refs = pc.refs.map(r => r.gsrc ? { ...r } : { ...r, pc: BF.plainPiece(r.pc) });   // refs 剥离运行对象（渲染中惰性解码塞进的 maskImg 不可克隆）
        if (L.pmDirty && L.piece.maskCanvas) {
            try { pc.maskURL = L.piece.maskCanvas.toDataURL("image/png"); } catch (e) { /* 理论不可达：遮罩是干净画布 */ }
        }
        pieces.push(pc);
        const mem = { ...pc };
        if (pc.inkURL && L.piece.inkImg) mem.inkImg = L.piece.inkImg;   // 冻结笔迹图已解码，直接复用
        if (pc.maskURL) {   // 旧解码图复用（本次没擦）；擦过的 URL 已变，重新解码，晚到补刷
            if (!L.pmDirty && L.piece.maskImg) mem.maskImg = L.piece.maskImg;
            else {
                mem.maskImg = new Image();
                mem.maskImg.onload = () => BF.refresh(ed.src);
                mem.maskImg.src = pc.maskURL;
            }
        }
        memPieces.push(mem);
    });
    const L0 = ed.layers[0];
    const row = { src: ed.src, dataURL, eraseURL, pieces: pieces.length ? pieces : undefined, scale: ed.scale, tf: (L0.visible || !pieces.length) ? [L0.x, L0.y, L0.s] : null, updatedAt: Date.now() };   // 原图层隐藏且已有配方（=分割走了）= tf 置空：渲染时不再画整张原图，只由配方拼
    BF.persist(row);
    // 同步接管（out 画布就是笔迹合成，无需等异步解码），刷新侧栏立即生效
    BF.store.set(ed.src, { mode: "overlay", img: out, eraseImg: ed.erase, eraseURL, pieces: memPieces.length ? memPieces : undefined, tf: row.tf, scale: ed.scale, dataURL, fileW: ed.fileW, fileH: ed.fileH, updatedAt: row.updatedAt });
    BF.refresh(ed.src);
    // 组合部件批量保存：动过的（位置/缩放 ≠ 进入时）各写一条——笔迹沿用旧数据，位移写进 tf；
    // 没动过的不落库（保持「未修正」状态）。无笔迹的用 1×1 透明 PNG 占位
    let n = 0;
    const gmap = new Map();   // gSrc → 该部件的全部图层（被分割过的部件会占两层）
    ed.layers.forEach(L => { if (L.gSrc) { const arr = gmap.get(L.gSrc); if (arr) arr.push(L); else gmap.set(L.gSrc, [L]); } });
    gmap.forEach((arr, src) => {
        const g = arr[0], cut = arr.filter(L => L.piece);
        if (!cut.length && g.x === g.gInit[0] && g.y === g.gInit[1] && g.s === g.gInit[2]) return;   // 没分割又没动过的不落库
        const row = { src, dataURL: cut.length ? BF.EMPTY_PNG() : (g.gData || BF.EMPTY_PNG()),   // 分割过：原图+旧笔迹都进了配方，dataURL 只留占位（否则渲染端会再画一遍）
                      scale: g.gScale || BF.MODEL_H / g.canvas.height,
                      tf: cut.length ? null : [g.x, g.y, g.s],   // tf 置空 = 渲染端只由两半配方拼回，不再画整张部件原图
                      fileW: g.canvas.width, fileH: g.canvas.height, updatedAt: Date.now() };
        if (cut.length) row.pieces = cut.map(L => {   // 两半各自落库（位置/缩放/裁剪随配方走）
            const pc = BF.plainPiece({ ...L.piece, x: L.x, y: L.y, s: L.s });
            if (L.crop) pc.crop = { ...L.crop };
            pc.name = L.name;   // 同上：部件两半的名字（含分割方位后缀）也要落库
            return pc;
        });
        BF.persist(row);
        BF.loadFix(row);
        n++;
    });
    // 组修正 = 主文件的位移（这套衣服的整体偏移）：之后同一套晚刷出来的部件自动套用；
    // 主文件回到自然位（还原后保存）则视为清除组修正。单独还原某部件不影响组修正
    const t = BF.parseTags(ed.src);
    if (t.name) {
        const gid = t.slot + "/" + t.name;
        if (L0.x || L0.y) {
            const g = { id: gid, tf: [L0.x, L0.y], updatedAt: Date.now() };
            BF.groups.set(gid, g);
            BF.persistGroup(g);
            BF.refresh();   // 已按旧位置渲染过的兄弟部件（无自身修正的）需要全量重画
        } else if (BF.groups.has(gid)) {
            BF.groups.delete(gid);
            BF.eraseGroup(gid);
            BF.refresh();
        }
    }
    BF.toast(n ? `已保存，含 ${n} 个组合部件，侧栏立即生效` : "已保存，侧栏立即生效");
    ed.dirty = false;   // 已落库：退出不再提醒未保存
    [300, 1200].forEach(ms => setTimeout(() => BF.refresh(), ms));   // 补刷兜底：保存后的即时刷新偶发被吞，分两次确保图像必定刷新
};

BF.restoreFix = function(src) {
    BF.store.delete(src);
    BF.erase(src);
    BF.refresh(src);
    const ed = BF.ed;
    const gl = ed?.layers.find(l => l.gSrc === src);   // 组合编辑还原配件：只复位该部件，主文件与其他配件不动
    if (gl) {
        ed.layers = ed.layers.filter(l => l === gl || l.gSrc !== src);   // 被分割过的部件会占两层：只留一层参与复位
        delete gl.piece; delete gl.crop;   // 去掉分割配方/裁剪框：复位成普通配件参考层
        const eff = BF.fixFor(src);   // 自身修正已删，重算有效修正（可能仍带组修正的整套偏移）
        gl.gInit = eff?.tf ? [...eff.tf] : [0, 0, 1];
        gl.x = gl.gInit[0]; gl.y = gl.gInit[1]; gl.s = gl.gInit[2];
        gl.ctx.globalCompositeOperation = "source-over";   // 重画为纯原图（已保存笔迹随修正一并删除）
        gl.ctx.clearRect(0, 0, gl.canvas.width, gl.canvas.height);
        const img = BF.seen.get(src);
        if (img?.complete) gl.ctx.drawImage(img, 0, 0);
        ed.undo.length = 0; ed.redo.length = 0;
        BF.applyLayer(gl);
        BF.renderStage();
        BF.toast("已还原该部件为原版");
        return;
    }
    if (ed && ed.src === src) {
        // 还原主文件 = 整套复原：配件修正一并删除、层复位到自然位（图层保留继续编辑），组修正同步清除。
        // 否则残留的部件位移在下次保存时又会被写回，画布上也回不到「原版对照」状态
        const seenG = new Set();
        ed.layers.forEach(l => {   // 逐部件复位：被分割过的部件占两层，只复位第一层，其余留给下面的过滤丢掉
            if (!l.gSrc) return;
            if (seenG.has(l.gSrc)) { l.gSrc = null; return; }
            seenG.add(l.gSrc);
            BF.store.delete(l.gSrc);
            BF.erase(l.gSrc);
            BF.refresh(l.gSrc);
            const img = BF.seen.get(l.gSrc);
            l.gInit = [0, 0, 1];
            l.x = 0; l.y = 0; l.s = 1;
            delete l.piece; delete l.crop;
            l.ctx.globalCompositeOperation = "source-over";
            l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
            if (img?.complete) l.ctx.drawImage(img, 0, 0);
        });
        const tg = BF.parseTags(src);
        if (tg.name) {
            const gid = tg.slot + "/" + tg.name;
            if (BF.groups.has(gid)) { BF.groups.delete(gid); BF.eraseGroup(gid); BF.refresh(); }
        }
        ed.layers = ed.layers.filter((L, i) => i === 0 || L.gSrc);   // 单文件编辑时过滤后自然只剩原图层
        ed.active = 0;
        ed.undo.length = 0; ed.redo.length = 0;
        ed.eraseCtx.clearRect(0, 0, ed.fileW, ed.fileH);   // 擦除遮罩一并清空
        ed.eraseDirty = false;
        const L0 = ed.layers[0];
        L0.x = 0; L0.y = 0; L0.s = 1; L0.visible = true;   // 分割时被隐藏的原图层一并恢复显示
        BF.applyLayer(L0);
        BF.redrawBase();
        BF.syncLayers();
        BF.toast(ed.group.length ? "已还原为原版（含全部部件）" : "已还原为原版");
        return;
    }
    BF.toast("已还原为原版");
};

/* ---------- 导出 / 导入 ----------
   修正码（BFIX.）：二进制打包 + deflate-raw 压缩 + Base2048（11 位/字符，比 base64
   的 6 位/字符再省 45%）；每行含笔迹 PNG 与擦除遮罩 PNG（橡皮擦除的原图区域）；纯位移
   修正（无笔迹）不带图像数据。 */
BF.rowPlain = (src, r) => ({ src, dataURL: r.dataURL, eraseURL: r.eraseURL, pieces: r.pieces?.map(BF.plainPiece), scale: r.scale, tf: r.tf, fileW: r.fileW, fileH: r.fileH, updatedAt: r.updatedAt });   // src 是 store 的键、不在值里，必须显式传入；pieces 过纯化：引用链里的运行对象（Image/Canvas）被 JSON 序列化成「{}」后导入，renderPiece 会把 {} 当遮罩喂 drawImage 直接抛 TypeError
BF.u8 = n => { const b = []; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return b; };   // varint
BF.binToB64 = u8 => {
    let s = "";
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
};
// Base2048：字节流按 11 位一组映射到 CJK 区 U+4E00..（2048 字 = 11 位，比 base64 密 45%）；
// 该区不受 Unicode 归一化和平台改写影响，社交平台可安全复制
BF.encB2048 = function(u8) {
    let acc = 0, bits = 0, out = "";
    for (const b of u8) {
        acc = (acc << 8) | b; bits += 8;
        if (bits >= 11) { bits -= 11; out += String.fromCharCode(0x4E00 + ((acc >>> bits) & 2047)); acc &= (1 << bits) - 1; }
    }
    if (bits) out += String.fromCharCode(0x4E00 + ((acc << (11 - bits)) & 2047));   // 末组右补零
    return out;
};
BF.decB2048 = function(s) {
    let acc = 0, bits = 0; const out = [];
    for (const c of s) {
        const v = c.charCodeAt(0) - 0x4E00;
        if (v < 0 || v > 2047) throw 0;
        acc = (acc << 11) | v; bits += 11;
        while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); acc &= (1 << bits) - 1; }   // while：一组 11 位可能凑出两个字节
    }
    return new Uint8Array(out);
};
BF.encCode = async function(rows) {
    const te = new TextEncoder(), bytes = [...BF.u8(rows.length)];   // 行数
    for (const r of rows) {
        const s = te.encode(r.src);
        bytes.push(...BF.u8(s.length), ...s);
        const d = r.dataURL === BF.EMPTY ? null : r.dataURL;   // 1×1 占位 = 纯位移，不带图像
        bytes.push(d ? 1 : 0);
        if (d) { const raw = Uint8Array.from(atob(d.split(",")[1]), c => c.charCodeAt(0)); bytes.push(...BF.u8(raw.length), ...raw); }
        const e2 = r.eraseURL || null;
        bytes.push(e2 ? 1 : 0);
        if (e2) { const raw = Uint8Array.from(atob(e2.split(",")[1]), c => c.charCodeAt(0)); bytes.push(...BF.u8(raw.length), ...raw); }
        const dv = new DataView(new ArrayBuffer(44));
        dv.setFloat64(0, r.updatedAt ?? 0);
        dv.setFloat64(8, r.scale ?? 1);
        bytes.push(r.tf ? 1 : 0);
        if (r.tf) { dv.setFloat64(16, r.tf[0]); dv.setFloat64(24, r.tf[1]); dv.setFloat64(32, r.tf[2] ?? 1); }   // 组行 tf 只有 [x,y]，s 补 1
        dv.setUint16(40, r.fileW ?? 0); dv.setUint16(42, r.fileH ?? 0);
        for (let i = 0; i < 44; i++) bytes.push(dv.getUint8(i));
    }
    // 第 3 段：复制块（行号索引 + 源矩形/位置）。四段各带数量前缀、无条件写读——空段若整段跳过，
    // 后面的段会整体前移错位（有引用链却无遮罩时，refs 的 JSON 会被当成 PNG 读→导入报「不是有效的修正码」）
    const withP = rows.map((r, i) => ({ pcs: r.pieces, i })).filter(x => x.pcs?.length);
    bytes.push(...BF.u8(withP.length));
    for (const w of withP) {
        bytes.push(...BF.u8(w.i), ...BF.u8(w.pcs.length));
        for (const pc of w.pcs) {
            const pd = new DataView(new ArrayBuffer(96));   // 12×float64：位置 x/y/s + 选区 w/h/ox/oy + 原图源 sx/sy/sw/sh + 笔迹 ink
            ["x", "y", "s", "w", "h", "ox", "oy", "sx", "sy", "sw", "sh", "ink"]
                .forEach((k, j) => pd.setFloat64(j * 8, pc[k] ?? 0));
            for (let k = 0; k < 96; k++) bytes.push(pd.getUint8(k));
        }
    }
    const withM = [];
    rows.forEach((r, i) => (r.pieces || []).forEach((pc, k) => pc.maskURL && withM.push({ i, k, pc })));
    bytes.push(...BF.u8(withM.length));   // 第 4 段：块遮罩 PNG
    for (const w of withM) {
        const raw = Uint8Array.from(atob(w.pc.maskURL.split(",")[1]), c => c.charCodeAt(0));
        bytes.push(...BF.u8(w.i), ...BF.u8(w.k), ...BF.u8(raw.length), ...raw);
    }
    // 第 5 段：块引用链（refs 纯数据 JSON，含嵌套块遮罩/笔迹 dataURL）。纯数据 deflate 压缩友好
    const withR = [];
    rows.forEach((r, i) => (r.pieces || []).forEach((pc, k) => pc.refs?.length && withR.push({ i, k, j: new TextEncoder().encode(JSON.stringify(pc.refs)) })));
    bytes.push(...BF.u8(withR.length));
    for (const w of withR) bytes.push(...BF.u8(w.i), ...BF.u8(w.k), ...BF.u8(w.j.length), ...w.j);
    // 第 6 段：顶层块冻结笔迹 PNG（行号+块号定位）
    const withI = [];
    rows.forEach((r, i) => (r.pieces || []).forEach((pc, k) => pc.inkURL && withI.push({ i, k, pc })));
    bytes.push(...BF.u8(withI.length));
    for (const w of withI) {
        const raw = Uint8Array.from(atob(w.pc.inkURL.split(",")[1]), c => c.charCodeAt(0));
        bytes.push(...BF.u8(w.i), ...BF.u8(w.k), ...BF.u8(raw.length), ...raw);
    }
    const z = await new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
    return "BFIX." + BF.encB2048(new Uint8Array(z));
};
BF.decCode = async function(code) {
    code = code.replace(/\s+/g, "");   // 社交平台换行/空格剥掉再解
    if (!code.startsWith("BFIX.") || typeof DecompressionStream === "undefined") throw 0;
    const buf = await new Response(new Blob([BF.decB2048(code.slice(5))]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    const b = new Uint8Array(buf), td = new TextDecoder();
    let p = 0;
    const vi = () => { let n = 0, sh = 0, x; do { x = b[p++]; n |= (x & 127) << sh; sh += 7; } while (x & 128); return n; };
    const rows = [];
    for (let i = 0, n = vi(); i < n; i++) {
        const sl = vi(), row = { src: td.decode(b.subarray(p, p += sl)) };   // len 必须先取，否则 subarray 起点错位
        if (b[p++]) {
            const dl = vi();
            row.dataURL = "data:image/png;base64," + BF.binToB64(b.subarray(p, p += dl));
        }
        if (b[p++]) {   // 擦除遮罩
            const el = vi();
            row.eraseURL = "data:image/png;base64," + BF.binToB64(b.subarray(p, p += el));
        }
        const tfFlag = b[p++];   // 尾部 = 标志位 1 字节 + 44 字节（updatedAt/scale/tf/fileW/fileH）
        const dv = new DataView(buf, p);
        row.updatedAt = dv.getFloat64(0); row.scale = dv.getFloat64(8);
        if (tfFlag) row.tf = [dv.getFloat64(16), dv.getFloat64(24), dv.getFloat64(32)];
        row.fileW = dv.getUint16(40); row.fileH = dv.getUint16(42);
        p += 44;
        rows.push(row);
    }
    const m = vi();   // 第 3 段：复制块（行号索引 + 源矩形/位置）。四段数量前缀固定写读，与编码端一一对应
    for (let j = 0; j < m; j++) {
        const idx = vi(), n2 = vi(), pcs = [];
        for (let k = 0; k < n2; k++) {
            const pd = new DataView(buf, p); p += 96;   // 12×float64，与编码端同序
            const pc = {};
            ["x", "y", "s", "w", "h", "ox", "oy", "sx", "sy", "sw", "sh", "ink"]
                .forEach((key, j) => pc[key] = pd.getFloat64(j * 8));
            pcs.push(pc);
        }
        if (rows[idx]) rows[idx].pieces = pcs;
    }
    const mm = vi();   // 第 4 段：块遮罩 PNG
    for (let j = 0; j < mm; j++) {
        const ri = vi(), ki = vi(), ml = vi();
        const url = "data:image/png;base64," + BF.binToB64(b.subarray(p, p += ml));
        const pc = rows[ri]?.pieces?.[ki];
        if (pc) pc.maskURL = url;
    }
    const mr = vi();   // 第 5 段：块引用链（refs JSON）
    for (let j = 0; j < mr; j++) {
        const ri = vi(), ki = vi(), rl = vi();
        const pc = rows[ri]?.pieces?.[ki];
        if (pc) pc.refs = JSON.parse(td.decode(b.subarray(p, p += rl)));
    }
    const mi = vi();   // 第 6 段：顶层块冻结笔迹 PNG
    for (let j = 0; j < mi; j++) {
        const ri = vi(), ki = vi(), il = vi();
        const pc = rows[ri]?.pieces?.[ki];
        if (pc) pc.inkURL = "data:image/png;base64," + BF.binToB64(b.subarray(p, p += il));
    }
    return rows;
};
BF.exportCode = function() {
    const text = document.getElementById("bfShareText");
    if (!text.value) { BF.toast("修正码还没生成好"); return; }
    text.select();
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text.value).then(() => BF.toast("修正码已复制到剪贴板"), () => BF.toast("请手动全选复制"));
    } else {
        document.execCommand("copy");
        BF.toast("修正码已复制");
    }
};
BF.importCode = async function(text) {
    text = (text || "").trim();
    let rows;
    try { rows = await BF.decCode(text); }
    catch (e) { BF.toast("不是有效的修正码"); return; }
    if (!Array.isArray(rows) || !rows.length) { BF.toast("修正码里没有数据"); return; }
    rows.forEach(row => {
        if (row.src?.startsWith("group:")) {   // 组修正行 → 组表
            const g = { id: row.src.slice(6), tf: row.tf?.slice(0, 2) ?? [0, 0], updatedAt: row.updatedAt ?? Date.now() };
            BF.groups.set(g.id, g);
            BF.persistGroup(g);
        } else { BF.persist(row); BF.loadFix(row); }   // loadFix 解码后各自 refresh
    });
    BF.refresh();   // 组修正影响的兄弟部件全量重画
    BF.toast(`已导入 ${rows.length} 条修正并生效`);
    BF.openPicker();   // openPicker 开头自带 closeAll，重建列表顺带刷新「已修正」徽标
};
