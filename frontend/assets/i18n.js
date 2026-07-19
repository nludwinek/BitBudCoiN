// System wielojęzyczności BitBudCoin. Działa na KAŻDEJ stronie, która wczyta
// ten plik - sam dokłada przełącznik do menu i tłumaczy elementy oznaczone
// atrybutem data-i18n="klucz". Strony bez takich atrybutów po prostu nie mają
// jeszcze nic do przetłumaczenia (przełącznik i tak się pojawi, bezpiecznie).

const translations = {
    pl: {
        nav_dashboard: "Dashboard", nav_explorer: "Explorer", nav_mining: "Kopanie",
        nav_network: "Sieć", nav_peers: "Peery", nav_exchange: "Giełda",
        nav_address: "Adres", nav_docs: "Docs", nav_wallet: "Portfel",

        wallet_h1: "Portfel", wallet_tab_create: "Nowy portfel", wallet_tab_manage: "Mój portfel",
        wallet_intro: "Klucz prywatny powstaje tutaj, w tej przeglądarce, i nigdy nigdzie nie jest wysyłany.",
        wallet_warning: "Jeśli zgubisz klucz prywatny, tracisz dostęp do adresu na zawsze. Zapisz go, zanim zamkniesz tę kartę.",
        wallet_generate_btn: "Wygeneruj nowy portfel",
        wallet_step1: "Twój adres BbC", wallet_step2: "Klucz publiczny",
        wallet_step3: "Klucz PRYWATNY — nigdy nikomu nie pokazuj",
        wallet_step4: "Zapisz na dysk", wallet_download_bundle: "Pobierz oba klucze (1 plik)",
        wallet_bundle_hint: "Ten jeden plik wystarczy, żeby później wczytać ten portfel w zakładce \"Mój portfel\".",
        wallet_confirm_saved: "Zapisałem klucz prywatny w bezpiecznym miejscu.",
        wallet_import_title: "Wczytaj portfel",
        wallet_import_hint: "Wklej tutaj treść pliku, który pobrałeś przy tworzeniu portfela (oba klucze naraz — rozpoznam je same).",
        wallet_load_btn: "Wczytaj portfel",
        wallet_import_error: "Nie znalazłem obu kluczy w wklejonym tekście — upewnij się, że wkleiłeś zarówno klucz prywatny, jak i publiczny.",
        wallet_receive_title: "Odbierz", wallet_copy_addr: "Kopiuj adres", wallet_share: "Udostępnij",
        wallet_send_title: "Wyślij", wallet_send_to: "Adres odbiorcy", wallet_send_amount: "Kwota (BbC)",
        wallet_send_fee: "Opłata", wallet_send_btn: "Wyślij",
        wallet_footer: "BitBudCoin (BbC) · klucz prywatny nigdy nie opuszcza tej przeglądarki",
        wallet_generating: "Generuję...", wallet_generate_error: "Nie udało się wygenerować portfela: ",
        wallet_copied: "Skopiowano ✓", wallet_selected: "Zaznaczono - Ctrl+C",
        wallet_load_error: "Błąd wczytywania kluczy: ", wallet_balance_error: "błąd",
        wallet_share_fallback: "Adres skopiowany (udostępnianie niedostępne w tej przeglądarce)",
        wallet_need_recipient: "Podaj adres odbiorcy", wallet_need_amount: "Podaj poprawną kwotę",
        wallet_fee_negative: "Opłata nie może być ujemna", wallet_signing: "Podpisuję i wysyłam...",
        wallet_send_success: "✅ Wysłano, czeka na potwierdzenie w bloku",

        miner_h1: "Kopanie", miner_pool_status: "Status puli",
        miner_auto_title: "Kopanie automatyczne (w tej przeglądarce)",
        miner_auto_desc: "Liczy hashe tutaj, na Twoim urządzeniu, i samo zgłasza znalezione shares — bez klikania czegokolwiek co chwilę.",
        miner_your_address: "Twój adres BbC", miner_start_btn: "Zacznij kopać",
        miner_stop_btn: "Zatrzymaj kopanie",
        miner_auto_hint: "Kopie dopóki ta karta jest otwarta na ekranie — zamknięcie karty albo zgaszenie ekranu telefonu może to zatrzymać.",
        miner_solo_title: "⚡ Solo — cała nagroda dla Ciebie",
        miner_solo_desc: "Liczy w tej przeglądarce, tak jak kopanie przez pulę — ale bez dzielenia się. Znajdziesz blok, cała nagroda trafia prosto na Twój adres.",
        miner_solo_start: "Zacznij kopać solo",
        miner_models_title: "Modele sprzętu (referencyjne)",
        miner_blocks_label: "Bloki",
        miner_attempts_label: "Próby",
        miner_bench_title: "Ile realnie liczy Twoje urządzenie?",
        miner_bench_desc: "Prawdziwy pomiar wykonany teraz, na żywo — nie specyfikacja z ulotki.",
        miner_bench_btn: "Sprawdź szybkość", miner_bench_running: "Liczę przez 1,5 sekundy...",
        miner_bench_busy: "Zatrzymaj najpierw kopanie, żeby pomiar był miarodajny.",
        miner_bench_estimate: "Przy obecnej trudności sieci: średnio", miner_bench_sec: "s",
        miner_bench_min: "min", miner_bench_hr: "godz.",
        miner_footer: "BitBudCoin (BbC) · sieć proof-of-work"
    },
    en: {
        nav_dashboard: "Dashboard", nav_explorer: "Explorer", nav_mining: "Mining",
        nav_network: "Network", nav_peers: "Peers", nav_exchange: "Exchange",
        nav_address: "Address", nav_docs: "Docs", nav_wallet: "Wallet",

        wallet_h1: "Wallet", wallet_tab_create: "New Wallet", wallet_tab_manage: "My Wallet",
        wallet_intro: "Your private key is created right here, in this browser, and is never sent anywhere.",
        wallet_warning: "If you lose your private key, you lose access to this address forever. Save it before closing this tab.",
        wallet_generate_btn: "Generate New Wallet",
        wallet_step1: "Your BbC Address", wallet_step2: "Public Key",
        wallet_step3: "PRIVATE Key — never show this to anyone",
        wallet_step4: "Save to Disk", wallet_download_bundle: "Download Both Keys (1 file)",
        wallet_bundle_hint: "This one file is all you need to load this wallet later under \"My Wallet\".",
        wallet_confirm_saved: "I've saved my private key somewhere safe.",
        wallet_import_title: "Load Wallet",
        wallet_import_hint: "Paste the contents of the file you downloaded when creating your wallet (both keys at once — they'll be detected automatically).",
        wallet_load_btn: "Load Wallet",
        wallet_import_error: "Couldn't find both keys in the pasted text — make sure you pasted both the private and public key.",
        wallet_receive_title: "Receive", wallet_copy_addr: "Copy Address", wallet_share: "Share",
        wallet_send_title: "Send", wallet_send_to: "Recipient Address", wallet_send_amount: "Amount (BbC)",
        wallet_send_fee: "Fee", wallet_send_btn: "Send",
        wallet_footer: "BitBudCoin (BbC) · your private key never leaves this browser",
        wallet_generating: "Generating...", wallet_generate_error: "Failed to generate wallet: ",
        wallet_copied: "Copied ✓", wallet_selected: "Selected - Ctrl+C",
        wallet_load_error: "Error loading keys: ", wallet_balance_error: "error",
        wallet_share_fallback: "Address copied (sharing not available in this browser)",
        wallet_need_recipient: "Enter recipient address", wallet_need_amount: "Enter a valid amount",
        wallet_fee_negative: "Fee cannot be negative", wallet_signing: "Signing and sending...",
        wallet_send_success: "✅ Sent, waiting for block confirmation",

        miner_h1: "Mining", miner_pool_status: "Pool Status",
        miner_auto_title: "Automatic Mining (in this browser)",
        miner_auto_desc: "Computes hashes right here on your device and automatically reports shares found — no need to keep clicking anything.",
        miner_your_address: "Your BbC Address", miner_start_btn: "Start Mining",
        miner_stop_btn: "Stop Mining",
        miner_auto_hint: "Mines as long as this tab stays open — closing the tab or locking your phone screen may stop it.",
        miner_solo_title: "⚡ Solo — Keep the Whole Reward",
        miner_solo_desc: "Computes right here in this browser, just like pool mining — but without sharing. Find a block, and the full reward goes straight to your address.",
        miner_solo_start: "Start Solo Mining",
        miner_models_title: "Hardware Models (reference)",
        miner_blocks_label: "Blocks",
        miner_attempts_label: "Attempts",
        miner_bench_title: "How fast is your device, really?",
        miner_bench_desc: "A real measurement taken right now, live — not a spec sheet.",
        miner_bench_btn: "Check speed", miner_bench_running: "Measuring for 1.5 seconds...",
        miner_bench_busy: "Stop mining first for an accurate reading.",
        miner_bench_estimate: "At the current network difficulty: on average", miner_bench_sec: "s",
        miner_bench_min: "min", miner_bench_hr: "hr",
        miner_footer: "BitBudCoin (BbC) · proof-of-work network"
    }
};

function detectLanguage() {
    const saved = localStorage.getItem("bbc_lang");
    if (saved && translations[saved]) return saved;
    const browserLang = (navigator.language || "pl").toLowerCase();
    return browserLang.startsWith("pl") ? "pl" : "en";
}

let currentLang = "pl";

function t(key) {
    return (translations[currentLang] && translations[currentLang][key]) || (translations.en[key]) || key;
}

function applyTranslations(lang) {
    currentLang = translations[lang] ? lang : "en";
    const dict = translations[currentLang];
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        if (dict[key]) el.textContent = dict[key];
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        const key = el.getAttribute("data-i18n-placeholder");
        if (dict[key]) el.placeholder = dict[key];
    });
    document.documentElement.lang = lang;
    document.querySelectorAll(".lang-switch-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.lang === lang);
    });
}

function setLanguage(lang) {
    localStorage.setItem("bbc_lang", lang);
    applyTranslations(lang);
}

function mountLangSwitcher() {
    const nav = document.querySelector(".nav");
    if (!nav || document.querySelector(".lang-switcher")) return;
    const wrap = document.createElement("div");
    wrap.className = "lang-switcher";
    wrap.style.cssText = "display:flex;gap:2px;margin-left:12px;";
    wrap.innerHTML = `
        <button class="lang-switch-btn" data-lang="pl" style="padding:5px 9px;font-size:.72rem;font-family:var(--font-mono);border:1px solid var(--border);background:var(--surface-2);color:var(--text-dim);border-radius:6px 0 0 6px;cursor:pointer;">PL</button>
        <button class="lang-switch-btn" data-lang="en" style="padding:5px 9px;font-size:.72rem;font-family:var(--font-mono);border:1px solid var(--border);border-left:none;background:var(--surface-2);color:var(--text-dim);border-radius:0 6px 6px 0;cursor:pointer;">EN</button>
    `;
    wrap.querySelectorAll(".lang-switch-btn").forEach((btn) => {
        btn.addEventListener("click", () => setLanguage(btn.dataset.lang));
    });
    nav.appendChild(wrap);

    const style = document.createElement("style");
    style.textContent = ".lang-switch-btn.active { background:var(--leaf) !important; color:#0b0f0d !important; }";
    document.head.appendChild(style);
}

function initI18n() {
    mountLangSwitcher();
    applyTranslations(detectLanguage());
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initI18n);
} else {
    initI18n();
}
