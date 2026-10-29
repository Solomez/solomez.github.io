(() => {
  const covers = document.querySelectorAll(".h-case .h-cover[data-loop]");
  if (!covers.length) return;
  const ok = matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
  const START = 0.3;
  const FADE = 160;
  const css = document.createElement("style");
  css.textContent =
    "body.home .h-cover .lc-v{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;pointer-events:none;" +
    `transition:opacity ${FADE}ms cubic-bezier(0.25,1,0.5,1)}` +
    "body.home .h-cover.lc-on .lc-v{opacity:1}" +
    "@media not all and (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){body.home .h-cover .lc-v{display:none}}";
  document.head.append(css);
  const all = [], main = document.querySelector("main.h-main");
  const tick = (cover) => { if (main) main.dispatchEvent(new CustomEvent("lc-tick", { detail: cover })); };
  const frames = (v, cover) => {
    if (v.lcRun) return;
    v.lcRun = true;
    const next = () => {
      if (!cover.classList.contains("lc-on") || v.paused) { v.lcRun = false; return; }
      v.lcV = (v.lcV || 0) + 1; tick(cover);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next); else requestAnimationFrame(next);
    };
    next();
  };
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  const saving = () => { const c = navigator.connection; return !!(c && c.saveData); };
  for (const cover of covers) {
    const card = cover.closest(".h-case"), link = card.querySelector(".h-case-link");
    let v = null, t = 0;
    const make = (preload) => {
      if (v) return v;
      v = document.createElement("video");
      v.className = "lc-v";
      v.muted = v.loop = v.playsInline = v.disablePictureInPicture = true;
      v.preload = preload;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("aria-hidden", "true");
      v.tabIndex = -1;
      v.src = cover.dataset.loop;
      (cover.querySelector("img") || cover.firstChild).after(v);
      v.addEventListener("playing", () => { if (cover.classList.contains("lc-want")) show(); else v.pause(); });
      all.push([cover, () => v]);
      return v;
    };
    const show = () => {
      cover.classList.add("lc-on");
      if (!v.lcTwin && main) { v.lcTwin = true; main.dispatchEvent(new CustomEvent("home-glass", { detail: cover })); }
      frames(v, cover);
    };
    const on = () => {
      if (!ok.matches) return;
      clearTimeout(t);
      make("auto");
      v.style.display = "";
      cover.classList.add("lc-want");
      if (!v.paused && v.readyState >= 2) { show(); return; }
      try { v.currentTime = START; } catch (e) {}
      v.play().catch(() => {});
    };
    const off = () => {
      clearTimeout(t);
      cover.classList.remove("lc-on", "lc-want");
      tick(cover);
      if (v) t = setTimeout(() => { if (!cover.classList.contains("lc-want")) v.pause(); }, FADE + 20);
    };
    card.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") on(); });
    card.addEventListener("pointerleave", off);
    if (link) {
      link.addEventListener("focus", () => { if (link.matches(":focus-visible")) on(); });
      link.addEventListener("blur", off);
    }
    cover.lcLoad = () => idle(() => { if (!v && ok.matches && !saving()) make("auto").load(); }, { timeout: 2000 });
  }
  if ("IntersectionObserver" in window && ok.matches) {
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); e.target.lcLoad(); }
    }, { rootMargin: "200px 0px" });
    for (const cover of covers) io.observe(cover);
  }
  const stop = () => {
    for (const [cover, get] of all) {
      const v = get();
      cover.classList.remove("lc-on", "lc-want");
      v.pause(); v.style.display = "none";
    }
  };
  addEventListener("pageswap", stop);
  addEventListener("pagehide", stop);
})();
