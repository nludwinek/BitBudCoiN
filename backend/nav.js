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
});
