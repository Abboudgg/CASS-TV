const KEY_STORAGE = "cass-tv-admin-key";
const form = document.getElementById("contentForm");
const list = document.getElementById("contentList");
const keyInput = document.getElementById("adminKey");
keyInput.value = sessionStorage.getItem(KEY_STORAGE) || "";

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
      meta.textContent = item.type === "movie" ? "فيلم" : "مسلسل";
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
    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = error.message;
    list.append(empty);
  }
}

function showMessage(message) {
  document.getElementById("formMessage").textContent = message;
}

keyInput.addEventListener("change", () => {
  sessionStorage.setItem(KEY_STORAGE, keyInput.value.trim());
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!keyInput.value.trim()) return showMessage("أدخل مفتاح الإدارة أولاً.");
  const payload = {
    type: document.getElementById("type").value,
    title: document.getElementById("title").value.trim(),
    poster: document.getElementById("poster").value.trim(),
    stream: document.getElementById("stream").value.trim(),
    description: document.getElementById("description").value.trim()
  };
  try {
    const response = await fetch("/api/content", {
      method: "POST", headers: adminHeaders(), body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showMessage(data.error || "تعذر حفظ المحتوى.");
    form.reset();
    keyInput.value = sessionStorage.getItem(KEY_STORAGE) || "";
    showMessage("تم حفظ المحتوى في قاعدة البيانات.");
    render();
  } catch {
    showMessage("تعذر الاتصال بالسيرفر.");
  }
});

document.getElementById("clearAll").addEventListener("click", () => {
  showMessage("لحذف المحتوى، استخدم زر حذف بجانب كل عنصر.");
});

render();
