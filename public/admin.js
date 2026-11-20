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

document.getElementById("clearAll").addEventListener("click", render);\ndocument.getElementById("refreshRequests")?.addEventListener("click", renderRequests);

render();
