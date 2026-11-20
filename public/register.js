const form=document.getElementById("registerForm");
const message=document.getElementById("message");
form.addEventListener("submit",async event=>{
  event.preventDefault();
  const username=document.getElementById("username").value.trim();
  const password=document.getElementById("password").value;
  const confirmPassword=document.getElementById("confirmPassword").value;
  if(password!==confirmPassword){message.textContent="كلمتا المرور غير متطابقتين.";return;}
  const button=form.querySelector("button");
  button.disabled=true;message.textContent="جارٍ إرسال الطلب...";
  try{
    const response=await fetch("/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||"تعذر إرسال الطلب.");
    form.reset();
    message.textContent="تم إرسال طلبك بنجاح. انتظر موافقة المدير قبل استخدام Xtream Codes.";
  }catch(error){message.textContent=error.message;}
  finally{button.disabled=false;}
});