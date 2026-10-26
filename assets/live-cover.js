// live-cover.js — the live cover (README «Live cover»; references-2026-10, mechanic 1). Only on pages whose case cards
// have a loop (.h-cover[data-loop], the home page and Work), only built with "liveCover": true in content/site.json.
// On a computer with a mouse: hovering a card (or tabbing to its link) loads the case's short silent loop on first use
// and fades it in over the cover (200 ms) once it plays; leaving fades it out and pauses it. The chips and the ring stay
// on top (DOM order: img, video, ring, chips). Phones, touch screens and reduced motion: nothing loads, nothing moves.
// pageswap / pagehide: the loops stop and hide at once, so a page transition's snapshot (anim/, View Transitions) or
// the back-forward cache never keeps a video frame.
// The glass (lens.js twins: the bend, the nav glass, the cursor lens) draws the loop as a live layer of the cover's twin
// (build.py LC_PATCHES): once the loop first plays, «home-glass» has lens.js paint that twin anew with the layer; each
// video frame sends «lc-tick» (frame count in video.lcV), so the glass over that cover is drawn again.
(() => {
  const covers = document.querySelectorAll(".h-case .h-cover[data-loop]");
  if (!covers.length) return;
  const ok = matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
  const css = document.createElement("style");
  css.textContent =
    "body.home .h-cover .lc-v{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;pointer-events:none;" +
    "transition:opacity 200ms cubic-bezier(0.25,1,0.5,1)}" +
    "body.home .h-cover.lc-on .lc-v{opacity:1}" +
    "@media not all and (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){body.home .h-cover .lc-v{display:none}}";
  document.head.append(css);
  const all = [], main = document.querySelector("main.h-main");
  const tick = (cover) => { if (main) main.dispatchEvent(new CustomEvent("lc-tick", { detail: cover })); };
  const frames = (v, cover) => {        // a new frame while the loop shows: the glass over the cover takes it
    const next = () => {
      if (!cover.classList.contains("lc-on") || v.paused) return;
      v.lcV = (v.lcV || 0) + 1; tick(cover);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next); else requestAnimationFrame(next);
    };
    next();
  };
  for (const cover of covers) {
    const card = cover.closest(".h-case"), link = card.querySelector(".h-case-link");
    let v = null, t = 0;
    const on = () => {
      if (!ok.matches) return;
      clearTimeout(t);
      t = setTimeout(() => {             // a short wait: a cursor passing over the card starts no download
        if (!v) {
          v = document.createElement("video");
          v.className = "lc-v";
          v.muted = v.loop = v.playsInline = v.disablePictureInPicture = true;
          v.preload = "none";
          v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("aria-hidden", "true");
          v.tabIndex = -1;
          v.src = cover.dataset.loop;
          (cover.querySelector("img") || cover.firstChild).after(v);
          v.addEventListener("playing", () => {
            if (!cover.classList.contains("lc-want")) return;
            cover.classList.add("lc-on");
            if (!v.lcTwin && main) { v.lcTwin = true; main.dispatchEvent(new CustomEvent("home-glass", { detail: cover })); }
            frames(v, cover);
          });
          all.push([cover, () => v]);
        }
        v.style.display = "";
        cover.classList.add("lc-want");
        v.play().catch(() => {});
      }, 80);
    };
    const off = () => {
      clearTimeout(t);
      cover.classList.remove("lc-on", "lc-want");
      tick(cover);
      if (v) setTimeout(() => { if (!cover.classList.contains("lc-want")) v.pause(); }, 220);
    };
    card.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") on(); });
    card.addEventListener("pointerleave", off);
    if (link) {
      link.addEventListener("focus", () => { if (link.matches(":focus-visible")) on(); });
      link.addEventListener("blur", off);
    }
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
