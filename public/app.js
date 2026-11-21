document.getElementById("year").textContent = new Date().getFullYear();

const catalog = document.querySelector(".catalog");
const originalGrid = catalog?.querySelector(".empty-grid");
if (catalog && originalGrid) {
  catalog.querySelector(":scope > p")?.remove();
  originalGrid.remove();

  const intro = document.createElement("p");
  intro.className = "catalog-status";
  intro.textContent = "يتم تحميل مكتبتك...";
  catalog.append(intro);

  const moviesSection = document.createElement("section");
  moviesSection.className = "library-section";
  moviesSection.id = "movie-library";
  const moviesTitle = document.createElement("h3");
  moviesTitle.textContent = "🎬 الأفلام";
  const moviesGrid = document.createElement("div");
  moviesGrid.className = "media-grid";
  moviesSection.append(moviesTitle, moviesGrid);

  const seriesSection = document.createElement("section");
  seriesSection.className = "library-section";
  seriesSection.id = "series";
  const seriesTitle = document.createElement("h3");
  seriesTitle.textContent = "📺 المسلسلات";
  const seriesGrid = document.createElement("div");
  seriesGrid.className = "media-grid";
  seriesSection.append(seriesTitle, seriesGrid);
  catalog.append(moviesSection, seriesSection);

  const playerDialog = document.createElement("dialog");
  playerDialog.className = "media-player-dialog";
  const playerClose = document.createElement("button");
  playerClose.type = "button";
  playerClose.className = "player-close";
  playerClose.textContent = "إغلاق ✕";
  const playerTitle = document.createElement("h3");
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  playerDialog.append(playerClose, playerTitle, video);
  document.body.append(playerDialog);

  const teasersSection = document.createElement("section");
  teasersSection.className = "content-section teaser-section";
  teasersSection.id = "trailers";
  const teaserHeading = document.createElement("div");
  teaserHeading.className = "section-heading";
  teaserHeading.innerHTML = '<div><span class="eyebrow">COMING SOON</span><h2>تشويقات الأفلام</h2><p>شاهد الإعلان قبل اختيار الفيلم.</p></div>';
  const teaserGrid = document.createElement("div");
  teaserGrid.className = "teaser-grid";
  teasersSection.append(teaserHeading, teaserGrid);
  document.querySelector(".hero")?.after(teasersSection);

  function makeTeaserCard(item) {
    const card = document.createElement("article");
    card.className = "teaser-card";
    const posterUrl = safeHttpUrl(item.poster);
    if (posterUrl) {
      const poster = document.createElement("img");
      poster.src = posterUrl;
      poster.alt = "غلاف " + item.title;
      poster.loading = "lazy";
      card.append(poster);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "teaser-poster-empty";
      placeholder.textContent = "🎬";
      card.append(placeholder);
    }
    const info = document.createElement("div");
    info.className = "teaser-info";
    const title = document.createElement("h3");
    title.textContent = item.title;
    const category = document.createElement("small");
    category.textContent = item.category || "عام";
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "media-play";
    watch.textContent = "▶ مشاهدة التشويقة";
    watch.addEventListener("click", () => {
      playerTitle.textContent = "تشويقة · " + item.title;
      video.src = safeHttpUrl(item.teaser_url);
      if (typeof playerDialog.showModal === "function") playerDialog.showModal();
      else playerDialog.setAttribute("open", "");
      video.play().catch(() => {});
    });
    info.append(title, category, watch);
    card.append(info);
    return card;
  }

  function closePlayer() {
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (playerDialog.open) playerDialog.close();
  }
  playerClose.addEventListener("click", closePlayer);
  playerDialog.addEventListener("click", event => {
    if (event.target === playerDialog) closePlayer();
  });
  playerDialog.addEventListener("close", closePlayer);

  function safeHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function makeCard(item) {
    const card = document.createElement("article");
    card.className = "media-card";

    const posterUrl = safeHttpUrl(item.poster);
    if (posterUrl) {
      const poster = document.createElement("img");
      poster.className = "media-poster";
      poster.src = posterUrl;
      poster.alt = "غلاف " + item.title;
      poster.loading = "lazy";
      poster.onerror = () => poster.remove();
      card.append(poster);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "media-poster media-poster-empty";
      placeholder.textContent = item.type === "series" ? "📺" : "🎬";
      card.append(placeholder);
    }

    const info = document.createElement("div");
    info.className = "media-info";
    const title = document.createElement("h4");
    title.textContent = item.title || "بدون عنوان";
    info.append(title);
    const category = document.createElement("small");
    category.className = "media-category";
    category.textContent = item.category || "عام";
    info.append(category);

    if (item.description) {
      const description = document.createElement("p");
      description.textContent = item.description;
      info.append(description);
    }

    if (item.type !== "series") {
      const streamUrl = safeHttpUrl(item.stream);
      const play = document.createElement("button");
      play.type = "button";
      play.className = "media-play";
      play.textContent = "▶ تشغيل";
      play.disabled = !streamUrl;
      play.addEventListener("click", () => {
        if (!streamUrl) return;
        playerTitle.textContent = item.title || "CASS TV";
        video.src = streamUrl;
        if (typeof playerDialog.showModal === "function") playerDialog.showModal();
        else playerDialog.setAttribute("open", "");
        video.play().catch(() => {});
      });
      info.append(play);
    }
    card.append(info);
    return card;
  }

  async function loadCatalog() {
    try {
      const response = await fetch("/api/content", { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "تعذر تحميل المكتبة.");
      }
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error("صيغة بيانات المكتبة غير صحيحة.");

      const movies = items.filter(item => item.type === "movie");
      const series = items.filter(item => item.type === "series");
      const teasers = movies.filter(item => safeHttpUrl(item.teaser_url));
      teaserGrid.replaceChildren(...teasers.map(makeTeaserCard));
      if (!teasers.length) {
        const emptyTeasers = document.createElement("p");
        emptyTeasers.className = "catalog-empty";
        emptyTeasers.textContent = "ستظهر هنا تشويقات الأفلام التي تضيفها من لوحة التحكم.";
        teaserGrid.append(emptyTeasers);
      }
      moviesGrid.replaceChildren(...movies.map(makeCard));
      seriesGrid.replaceChildren(...series.map(makeCard));

      if (!movies.length) {
        const empty = document.createElement("p");
        empty.className = "catalog-empty";
        empty.textContent = "لا توجد أفلام مضافة حالياً.";
        moviesGrid.append(empty);
      }
      if (!series.length) {
        const empty = document.createElement("p");
        empty.className = "catalog-empty";
        empty.textContent = "لا توجد مسلسلات مضافة حالياً.";
        seriesGrid.append(empty);
      }
      intro.textContent = "مكتبة CASS TV · " + movies.length + " أفلام · " + series.length + " مسلسلات";
    } catch (error) {
      intro.textContent = error.message + " حاول تحديث الصفحة.";
    }
  }

  loadCatalog();
}
