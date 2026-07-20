async function mountNavStatus() {
    // Dwa warianty spotykane na różnych stronach: pojedynczy element "navStatus"
    // (miner.html, wallet.html) albo rozdzielony "nav-status" + "nav-status-text"
    // (dashboard.html, explorer.html, itd.). Obsługujemy oba.
    const combined = document.getElementById("navStatus");
    const splitPill = document.getElementById("nav-status");
    const splitText = document.getElementById("nav-status-text");
    const pill = combined || splitPill;
    if (!pill) return;

    const setText = (html) => {
        if (combined) pill.innerHTML = `<span class="flame-dot"></span>${html}`;
        else if (splitText) splitText.textContent = html;
    };

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(API_BASE + "/info", { signal: controller.signal });
        clearTimeout(timeoutId);
        const info = await res.json();
        if (!res.ok) throw new Error("status " + res.status);
        pill.classList.add("lit");
        setText(`blok #${fmtNumber(info.height, 0)}`);
    } catch (e) {
        pill.classList.remove("lit");
        setText("offline");
    }
}
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", mountNavStatus); } else { mountNavStatus(); }
