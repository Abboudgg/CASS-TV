const KEY_STORAGE = "cass-tv-admin-key";
const form = document.getElementById("contentForm");
const list = document.getElementById("contentList");
const keyInput = document.getElementById("adminKey");
const typeInput = document.getElementById("type");
const streamInput = document.getElementById("stream");
const streamHint = document.getElementById("streamHint");
keyInput.value = sessionStorage.getItem(KEY_STORAGE) || "";

function updateStreamHelp() {
  const isLive = typeInput.value === "live";
  streamInput.placeholder = isLive
    ? "https://example.com/live/stream.m3u8"
    : "https://example.com/video.mp4";
  streamHint.textContent = isLive
    ? "للبث المباشر استخدم رابط HLS بصيغة M3U8. روابط البث المباشر الحالية تبقى مدعومة كما هي."
    : "للأفلام والمسلسلات استخدم رابط فيديو MP4 مباشر. روابط M3U8 مخصصة للبث المباشر.";
}

typeInput.addEventListener("change", updateStreamHelp);
updateStreamHelp();

function adminHeaders() {
  return { "Content-Type": "application/json", "x-admin-key": keyInput.value.trim() };
}

async function render() {
  try {
    const response = await fetch("/api/content");
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "تعذر تحميل المكتبة.");
    }
    const items = await response.json();
    document.getElementById("totalCount").textContent = items.length;
    document.getElementById("movieCount").textContent = items.filter(x => x.type === "movie").length;
    document.getElementById("seriesCount").textContent = items.filter(x => x.type === "series").length;
    document.getElementById("liveCount").textContent = items.filter(x => x.type === "live").length;
    if (!items.length) {
      list.innerHTML = '<div class="empty">ما أضفت أي محتوى حتى الآن.</div>';
      return;
    }
    list.replaceChildren();
    items.forEach(item => {
      const row = document.createElement("article");
      row.className = "entry";
      const details = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = item.title;
      const meta = document.createElement("p");
      meta.textContent = item.type === "movie" ? "فيلم · MP4" : item.type === "series" ? "مسلسل · MP4" : "بث مباشر · M3U8 · يظهر في قائمة التشغيل";
      details.append(title, meta);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "حذف";
      remove.addEventListener("click", async () => {
        if (!keyInput.value.trim()) return showMessage("أدخل مفتاح الإدارة أولاً.");
        const response = await fetch("/api/content/" + encodeURIComponent(item.id), {
          method: "DELETE", headers: adminHeaders()
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showMessage(data.error || "تعذر الحذف.");
        render();
      });
      row.append(details, remove);
      list.append(row);
    });
  } catch (error) {
    document.getElementById("totalCount").textContent = "—";
    document.getElementById("movieCount").textContent = "—";
    document.getElementById("seriesCount").textContent = "—";
    document.getElementById("liveCount").textContent = "—";
    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = error.message;
    list.append(empty);
  }
}

async function renderRequests() {
  const requestList = document.getElementById("requestList");
  if (!requestList) return;
  if (!keyInput.value.trim()) {
    requestList.textContent = "أدخل مفتاح الإدارة أعلاه لعرض الطلبات.";
    return;
  }
  try {
    const response = await fetch("/api/xtream/requests", { headers: adminHeaders() });
    const data = await response.json().catch(() => []);
    if (!response.ok) throw new Error(data.error || "تعذر تحميل الطلبات.");
    requestList.replaceChildren();
    if (!data.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "لا توجد طلبات معلّقة حالياً.";
      requestList.append(empty);
      return;
    }
    data.forEach(request => {
      const row = document.createElement("article");
      row.className = "entry";
      const details = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = request.username;
      const meta = document.createElement("p");
      meta.textContent = "طلب تسجيل جديد · " + new Date(request.created_at).toLocaleString("ar-SA");
      details.append(title, meta);
      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.flexWrap = "wrap";
      actions.style.gap = "8px";
      const duration = document.createElement("select");
      duration.setAttribute("aria-label", "مدة الاشتراك");
      [["7","7 أيام"],["30","30 يومًا"],["90","90 يومًا"],["180","180 يومًا"],["0","دائم"]].forEach(([value,label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        duration.append(option);
      });
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "موافقة";
      approve.addEventListener("click", async () => {
        approve.disabled = true;
        const result = await fetch("/api/xtream/requests/" + request.id + "/approve", {
          method: "POST", headers: adminHeaders(), body: JSON.stringify({ duration_days: Number(duration.value) })
        });
        const body = await result.json().catch(() => ({}));
        if (!result.ok) { approve.disabled = false; return alert(body.error || "تعذرت الموافقة."); }
        await renderRequests();
        await render();
        alert("تمت الموافقة وإنشاء حساب Xtream للمستخدم " + body.user.username);
      });
      const reject = document.createElement("button");
      reject.type = "button";
      reject.textContent = "رفض";
      reject.addEventListener("click", async () => {
        if (!confirm("هل تريد رفض طلب " + request.username + "؟")) return;
        const result = await fetch("/api/xtream/requests/" + request.id + "/reject", { method: "POST", headers: adminHeaders() });
        const body = await result.json().catch(() => ({}));
        if (!result.ok) return alert(body.error || "تعذر رفض الطلب.");
        renderRequests();
      });
      actions.append(duration, approve, reject);
      row.append(details, actions);
      requestList.append(row);
    });
  } catch (error) {
    requestList.textContent = error.message;
  }
}

function showMessage(message) {
  document.getElementById("formMessage").textContent = message;
}

keyInput.addEventListener("change", () => {
  sessionStorage.setItem(KEY_STORAGE, keyInput.value.trim());
  renderRequests();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!keyInput.value.trim()) return showMessage("أدخل مفتاح الإدارة أولاً.");
  const payload = {
    type: typeInput.value,
    title: document.getElementById("title").value.trim(),
    poster: document.getElementById("poster").value.trim(),
    stream: streamInput.value.trim(),
    description: document.getElementById("description").value.trim()
  };
  if (payload.type === "live" && !/\.m3u8(?:$|[?#])/i.test(payload.stream)) {
    return showMessage("رابط البث المباشر يجب أن يكون بصيغة M3U8.");
  }
  if (payload.type !== "live" && !/\.mp4(?:$|[?#])/i.test(payload.stream)) {
    return showMessage("رابط الفيلم أو المسلسل يجب أن يكون بصيغة MP4.");
  }
  try {
    const response = await fetch("/api/content", {
      method: "POST", headers: adminHeaders(), body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showMessage(data.error || "تعذر حفظ المحتوى.");
    form.reset();
    keyInput.value = sessionStorage.getItem(KEY_STORAGE) || "";
    updateStreamHelp();
    showMessage("تم حفظ المحتوى في قاعدة البيانات.");
    render();
  } catch {
    showMessage("تعذر الاتصال بالسيرفر.");
  }
});

document.getElementById("clearAll").addEventListener("click", render);
document.getElementById("refreshRequests")?.addEventListener("click", renderRequests);

render();
renderRequests();


// Seasons and episodes manager
const seriesSelect = document.getElementById("seriesSelect");
const episodeSeason = document.getElementById("episodeSeason");
const seasonOverview = document.getElementById("seasonOverview");
async function loadSeriesManager() {
  try {
    const response = await fetch("/api/content", { cache: "no-store" });
    const items = await response.json();
    const series = items.filter(item => item.type === "series");
    seriesSelect.replaceChildren();
    if (!series.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "لا توجد مسلسلات؛ أضف مسلسلاً أولاً";
      seriesSelect.append(option);
      episodeSeason.replaceChildren(new Option("أضف موسماً أولاً", ""));
      seasonOverview.textContent = "";
      return;
    }
    series.forEach(item => seriesSelect.add(new Option(item.title, item.id)));
    await loadSeasonOptions();
  } catch (_error) {
    seriesSelect.replaceChildren(new Option("تعذر تحميل المسلسلات", ""));
  }
}
async function loadSeasonOptions() {
  const id = seriesSelect.value;
  episodeSeason.replaceChildren(new Option("اختر موسماً", ""));
  seasonOverview.replaceChildren();
  if (!id) return;
  try {
    const response = await fetch("/api/series/" + encodeURIComponent(id) + "/seasons");
    const seasons = await response.json();
    if (!response.ok) throw new Error(seasons.error || "تعذر تحميل المواسم.");
    seasons.forEach(season => {
      episodeSeason.add(new Option("الموسم " + season.season_number + " · " + season.title, season.id));
      const row = document.createElement("article");
      row.className = "entry";
      const detail = document.createElement("div");
      const heading = document.createElement("h3");
      heading.textContent = "الموسم " + season.season_number + " · " + season.title;
      const meta = document.createElement("p");
      meta.textContent = season.episodes.length + " حلقة";
      detail.append(heading, meta);
      row.append(detail);
      seasonOverview.append(row);
    });
    if (!seasons.length) seasonOverview.textContent = "لم تتم إضافة مواسم لهذا المسلسل بعد.";
  } catch (error) {
    seasonOverview.textContent = error.message;
  }
}
seriesSelect.addEventListener("change", loadSeasonOptions);
document.getElementById("addSeason").addEventListener("click", async () => {
  const id = seriesSelect.value;
  if (!id || !keyInput.value.trim()) return document.getElementById("seasonMessage").textContent = "اختر مسلسلاً وأدخل مفتاح الإدارة.";
  const payload = { season_number: Number(document.getElementById("seasonNumber").value), title: document.getElementById("seasonTitle").value.trim() };
  const response = await fetch("/api/series/" + encodeURIComponent(id) + "/seasons", { method: "POST", headers: adminHeaders(), body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  document.getElementById("seasonMessage").textContent = response.ok ? "تمت إضافة الموسم." : (data.error || "تعذرت إضافة الموسم.");
  if (response.ok) { document.getElementById("seasonTitle").value = ""; await loadSeasonOptions(); }
});
document.getElementById("addEpisode").addEventListener("click", async () => {
  const id = episodeSeason.value;
  if (!id || !keyInput.value.trim()) return document.getElementById("episodeMessage").textContent = "اختر موسماً وأدخل مفتاح الإدارة.";
  const payload = { episode_number: Number(document.getElementById("episodeNumber").value), title: document.getElementById("episodeTitle").value.trim(), stream: document.getElementById("episodeStream").value.trim() };
  const response = await fetch("/api/seasons/" + encodeURIComponent(id) + "/episodes", { method: "POST", headers: adminHeaders(), body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  document.getElementById("episodeMessage").textContent = response.ok ? "تمت إضافة الحلقة." : (data.error || "تعذرت إضافة الحلقة.");
  if (response.ok) { document.getElementById("episodeTitle").value = ""; document.getElementById("episodeStream").value = ""; await loadSeasonOptions(); }
});

