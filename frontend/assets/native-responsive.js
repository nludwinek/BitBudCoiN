// Responsywne menu - na wąskich ekranach (telefon) chowa listę stron pod
// przycisk ☰, na szerokich (komputer) pokazuje wszystko normalnie, jak dotąd.
function mountResponsiveNav() {
    const nav = document.querySelector(".nav");
    const links = document.querySelector(".nav-links");
    if (!nav || !links || document.querySelector(".nav-toggle")) return;

    const toggle = document.createElement("button");
    toggle.className = "nav-toggle";
    toggle.textContent = "☰";
    toggle.setAttribute("aria-label", "Menu");
    toggle.addEventListener("click", () => links.classList.toggle("open"));
    nav.insertBefore(toggle, links);

    document.addEventListener("click", (e) => {
        if (!nav.contains(e.target)) links.classList.remove("open");
    });
    links.querySelectorAll("a").forEach((a) => {
        a.addEventListener("click", () => links.classList.remove("open"));
    });

    if (!document.getElementById("responsive-nav-style")) {
        const style = document.createElement("style");
        style.id = "responsive-nav-style";
        style.textContent = `
            .nav-toggle { display:none; background:none; border:none; color:var(--text); font-size:1.5rem; cursor:pointer; padding:4px 8px; }
            @media (max-width: 680px) {
                .nav-toggle { display:block; order:1; }
                .nav-links { display:none; flex-direction:column; width:100%; order:3;
                    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm);
                    padding:8px; margin-top:10px; position:absolute; top:100%; left:0; right:0; }
                .nav-links.open { display:flex; }
                .nav-links a { padding:12px 10px; border-bottom:1px solid var(--border); }
                .nav-links a:last-child { border-bottom:none; }
                .nav { position:relative; flex-wrap:wrap; }
                .lang-switcher { order:2; margin-left:auto !important; }
            }
        `;
        document.head.appendChild(style);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountResponsiveNav);
} else {
    mountResponsiveNav();
}
