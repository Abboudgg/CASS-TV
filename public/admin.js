const STORAGE_KEY = "cass-tv-demo-library";
const form = document.getElementById("contentForm");
const list = document.getElementById("contentList");
const readItems = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
};
const saveItems = (items) => localStorage.setItem(STORAGE_KEY, JSON.stringify(items));

function render() {
  const items = readItems();
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
    remove.addEventListener("click", () => {
      saveItems(readItems().filter(x => x.id !== item.id));
      render();
    });
    row.append(details, remove);
    list.append(row);
  });
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const title = document.getElementById("title").value.trim();
  if (!title) return;
  const items = readItems();
  items.unshift({
    id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    type: document.getElementById("type").value,
    title,
    poster: document.getElementById("poster").value.trim(),
    stream: document.getElementById("stream").value.trim(),
    description: document.getElementById("description").value.trim()
  });
  saveItems(items);
  form.reset();
  document.getElementById("formMessage").textContent = "تمت الإضافة إلى المكتبة التجريبية في هذا المتصفح.";
  render();
});

document.getElementById("clearAll").addEventListener("click", () => {
  if (!confirm("متأكد من حذف كل عناصر المكتبة التجريبية من هذا المتصفح؟")) return;
  saveItems([]);
  render();
});
render();
