async function mountNavStatus() {
    const pill = document.getElementById("nav-status");
    const text = document.getElementById("nav-status-text");
    if (!pill) return;
    try {
        const info = await apiGet("/info");
        pill.classList.add("lit");
        text.textContent = `blok #${fmtNumber(info.height, 0)}`;
    } catch (e) {
        pill.classList.remove("lit");
        text.textContent = "offline";
    }
}

function setActiveNav(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add("active");
}

document.addEventListener("DOMContentLoaded", () => {
    mountSmokeField();
    mountNavStatus();
});// Uzupełnia menu o linki, których mogło zabraknąć na starszych stronach
function ensureNavLinks() {
    const container = document.querySelector(".nav-links");
    if (!container) return;
    const required = [
        { href: "miner.html", label: "Kopanie" },
        { href: "wallet.html", label: "Portfel" }
    ];
    for (const link of required) {
        const exists = Array.from(container.querySelectorAll("a")).some((a) => a.getAttribute("href") === link.href);
        if (!exists) {
            const a = document.createElement("a");
            a.href = link.href;
            a.textContent = link.label;
            container.appendChild(a);
        }
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureNavLinks);
} else {
    ensureNavLinks();
}
