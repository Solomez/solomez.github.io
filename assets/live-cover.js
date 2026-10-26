// live-cover.js — the live cover (README «Live cover»; references-2026-10, mechanic 1). Only on pages whose case cards
// have a loop (.h-cover[data-loop], the home page and Work), only built with "liveCover": true in content/site.json.
// A loop is the whole cover, frame for frame, in which only the device's screen plays the case: it opens with HOLD s of
// the still cover, then the screen cuts to the case's own interface (no blend between two screens).
// On a computer with a mouse: once a card is in view, its loop loads in idle time, so the first hover is instant.
// Hovering a card (or tabbing to its link) starts the loop at START (still the cover) and fades it in (160 ms, the same
// picture, so nothing visibly changes but the screen coming alive); leaving fades it out and pauses it. The chips and the
// ring stay on top (DOM order: img, video, ring, chips). Phones, touch screens and reduced motion: nothing loads, nothing
// moves. pageswap / pagehide: the loops stop and hide at once, so a page transition's snapshot (anim/, View Transitions)
// or the back-forward cache never keeps a video frame.
// The glass (lens.js twins: the bend, the nav glass, the cursor lens) draws the loop as a live layer of the cover's twin
// (build.py LC_PATCHES): once the loop first plays, «home-glass» has lens.js paint that twin anew with the layer; each
// video frame sends «lc-tick» (frame count in video.lcV), so the glass over that cover is drawn again.
(() => {
  const covers = document.querySelectorAll(".h-case .h-cover[data-loop]");
  if (!covers.length) return;
  const ok = matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
  const START = 0.3;                     // each loop holds the still cover for 0.5 s; a hover starts 0.2 s before the cut
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
  const frames = (v, cover) => {        // a new frame while the loop shows: the glass over the cover takes it
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
    const make = (preload) => {           // the video element, made once: in idle time once the card is in view, or on hover
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
      if (!v.paused && v.readyState >= 2) { show(); return; }   // back before it paused: it simply shows again
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
  if ("IntersectionObserver" in window && ok.matches) {   // load a loop ahead, once its card comes near the view
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
