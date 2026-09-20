"use strict";(()=>{var v=(...e)=>{},o={isActive:!1,isDomainAllowed:!1,isInitialized:!1,settings:{responseMode:"direct",autoDetect:!0,highlightQuestions:!0,quickMode:!0,sendImages:!1,buttonPosition:"bottom-right"},detectedQuestions:[],currentVisibleQuestion:null,overlayVisible:!1,contentObserver:null,lastAnsweredQuestionNum:null,questionChangeObserver:null,questionChangeInterval:null,isRequestInProgress:!1,hasValidAnswer:!1,skipPrimary:!1,slowConnectionTimer:null,requestCancelled:!1,pendingQuestionChange:null,saButtonHidden:!1},ye=[];function T(e,t=document){let s=[];function n(i){if(i.shadowRoot){try{let r=i.shadowRoot.querySelectorAll(e);s.push(...Array.from(r))}catch{}let a=i.shadowRoot.querySelectorAll("*");for(let r of a)n(r)}}try{let i=t.querySelectorAll(e);s.push(...Array.from(i))}catch{}"shadowRoot"in t&&t.shadowRoot&&n(t);try{let i=t.querySelectorAll("*");for(let a of i)n(a)}catch{}return s}function ve(e=document){let t=[];function s(i){if(i.shadowRoot){t.push({element:i.tagName,shadowRoot:i.shadowRoot});let a=i.shadowRoot.querySelectorAll("*");for(let r of a)s(r)}}let n=e.querySelectorAll("*");for(let i of n)s(i);return t}function J(e){let t="";function s(n){if(n.nodeType===Node.TEXT_NODE)t+=n.textContent+" ";else if(n.nodeType===Node.ELEMENT_NODE){let i=n;if(i.shadowRoot)for(let a of i.shadowRoot.childNodes)s(a);for(let a of n.childNodes)s(a)}}return s(e),t.replace(/\s+/g," ").trim()}function be(e){let t="";for(let s of e.childNodes)s.nodeType===Node.TEXT_NODE&&(t+=s.textContent);return t}function F(e){let t=window.getComputedStyle(e);if(t.display==="none"||t.visibility==="hidden"||t.opacity==="0")return"";let s="",n=document.createTreeWalker(e,NodeFilter.SHOW_TEXT,{acceptNode:a=>{let r=a.parentElement;if(!r)return NodeFilter.FILTER_REJECT;let c=window.getComputedStyle(r);return c.display==="none"||c.visibility==="hidden"?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}}),i;for(;i=n.nextNode();)s+=i.textContent+" ";return s.replace(/\s+/g," ").trim()}function H(e){let t=[],s=new Set;function n(l){let f=l?.trim();f&&f.length>20&&!s.has(f)&&(s.add(f),t.push(f))}function i(l){if(!l)return;l instanceof Element&&l.classList?.contains("a11y_description")&&n(l.textContent);let f=l.querySelectorAll?.(".a11y_description");if(f)for(let p of f)n(p.textContent);if(l instanceof Element&&l.shadowRoot){let p=l.shadowRoot.querySelectorAll(".a11y_description");for(let u of p)n(u.textContent);let g=l.shadowRoot.querySelectorAll("*");for(let u of g)i(u)}}i(e);let a=T("[role='figure']",e);for(let l of a){let f=l.getAttribute("aria-labelledby");if(f){let p=T(`#${f}`,e)[0];p&&n(p.textContent)}}let r=T("dynamic-graphic-view",e);for(let l of r)i(l);let c=T("tabs-view",e);for(let l of c)i(l);return t.length>0&&v("[Study Assist] Found accessibility descriptions:",t.length),t.join(`

`)}function xe(e){let t=e.getBoundingClientRect(),s=window.innerHeight,n=window.innerWidth;if(t.bottom<0||t.top>s||t.right<0||t.left>n)return 0;let i=Math.max(0,t.top),a=Math.min(s,t.bottom),r=Math.max(0,t.left),c=Math.min(n,t.right),l=a-i,f=c-r,p=l*f,g=t.width*t.height;if(g===0)return 0;let u=(t.top+t.bottom)/2,d=s/2,m=1-Math.abs(u-d)/s;return p/g*.7+m*.3}function we(e,t){for(let s of t)if(s.element.contains(e)&&s.element!==e)return!0;return!1}function ee(e,t){return e.length<=t?e:e.substring(0,t).trim()+"..."}function S(e){let t=document.createElement("div");return t.textContent=e,t.innerHTML}function te(e){let t=S(e);return t=t.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>"),t=t.replace(/__(.+?)__/g,"<strong>$1</strong>"),t=t.replace(/\*(.+?)\*/g,"<em>$1</em>"),t=t.replace(/_(.+?)_/g,"<em>$1</em>"),t=t.replace(/\n\n/g,"</p><p>"),t=t.replace(/\n/g,"<br>"),t=`<p>${t}</p>`,t}function I(e){try{let t=new URL(e);if(t.protocol!=="https:"||t.username||t.password||t.search||t.hash)return!1;let s=t.hostname.toLowerCase();return!s.includes(".")||s.includes(":")||/^\d+(\.\d+){3}$/.test(s)||/(^|\.)(localhost|local|internal|home|lan)$/.test(s)?!1:!t.pathname.includes("/pluginfile.php/")}catch{return!1}}async function se(e){let t=[],s=T("img",e);for(let n of s)try{let i=n.src;if(i.startsWith("data:")&&i.length<500||i.includes("icon")||i.includes("logo")||i.includes("avatar"))continue;n.complete||await new Promise(c=>{n.onload=()=>c(),n.onerror=()=>c(),setTimeout(c,3e3)});let a=n.naturalWidth||n.width||100,r=n.naturalHeight||n.height||100;if(a<30||r<30)continue;if(I(i))t.push({url:i,mediaType:"image/jpeg"});else{let c=await B(n);c&&t.push(c)}}catch(i){console.warn("[Study Assist] Failed to extract image:",i)}return t}async function B(e){return new Promise(t=>{try{if(!e.complete){e.onload=()=>qe(e,t),e.onerror=()=>t(null);return}qe(e,t)}catch(s){console.warn("[Study Assist] Image conversion error:",s),t(null)}})}function qe(e,t){try{let s=document.createElement("canvas");if(s.width=e.naturalWidth||e.width,s.height=e.naturalHeight||e.height,s.width<50||s.height<50){t(null);return}let n=s.getContext("2d");if(!n){t(null);return}n.drawImage(e,0,0);let a=s.toDataURL("image/png").replace(/^data:image\/\w+;base64,/,"");t({base64:a,mediaType:"image/png"})}catch{je(e.src).then(t).catch(()=>t(null))}}async function je(e){try{let s=await(await fetch(e)).blob();return new Promise((n,i)=>{let a=new FileReader;a.onloadend=()=>{let c=a.result.replace(/^data:image\/\w+;base64,/,""),l=s.type||"image/png";n({base64:c,mediaType:l})},a.onerror=i,a.readAsDataURL(s)})}catch(t){return console.warn("[Study Assist] Failed to fetch image:",t),null}}var V={questionMarkers:/\?|what|which|how|why|when|where|who|whose|whom|explain|describe|define|identify|select|choose|pick|determine|calculate|compute|find|solve|analyze|evaluate|compare|contrast|list|name|state|qué|cuál|cómo|por\s*qué|cuándo|dónde|quién|pregunta\s*\d+/i,multipleChoice:[/^\s*[A-Da-d][\.\)\:]?\s+.+/m,/^\s*\([A-Da-d]\)\s+.+/m,/^\s*[1-4][\.\)\:]?\s+.+/m,/\b(?:option|choice|answer)\s*[A-Da-d1-4]/i,/<input[^>]*type=["']?radio["']?[^>]*>/i,/\bselect\s+(?:one|all|the\s+(?:correct|best|right))/i,/radio_button_(?:checked|unchecked)/i,/pregunta\s*\d+/i],trueFalse:[/\b(?:true|false)\b.*\b(?:true|false)\b/i,/^\s*(?:True|False|T|F)[\.\)\s]/m,/\b(?:is\s+this|this\s+is)\s+(?:true|false|correct|incorrect)\b/i,/\b(?:verdadero|falso)\b/i],fillBlank:[/_{2,}|\.{3,}|\[?\s*blank\s*\]?/i,/fill\s+(?:in\s+)?(?:the\s+)?(?:blank|gap)/i,/complete\s+(?:la|el|los|las)/i]};function ne(e){if(!e||e.length<100)return e;let t=[/(?:consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n|figura|tabla|gr[aá]fic[ao]))[.:,]?\s*/i,/(?:refer\s+to\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i,/(?:see\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i];for(let a of t){let r=e.match(a);if(r&&r.index!==void 0){let c=e.substring(r.index).trim();if(c.includes("?"))return v(`[Study Assist] Cleaned question text: "${e.substring(0,50)}..." \u2192 "${c.substring(0,100)}..."`),c}}let s=e.split(`
`).map(a=>a.trim()).filter(a=>a.length>0),n=/^[A-Z]\s+[\d\.:/]+|^\w+\([^)]+\)\s*#|^[\d\.]+ \[|gateway\s+of\s+last\s+resort/i;if(s.filter(a=>n.test(a)).length>s.length*.3){let a=e.split(/[.!¿]\s+/).filter(r=>r.includes("?"));if(a.length>0){let r=a[a.length-1].trim(),c=e.match(/(consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n)[.:,]?\s+[^¿?]+\?)/i);return c?(v(`[Study Assist] Cleaned question text (table detected): "${e.substring(0,50)}..." \u2192 "${c[1].trim().substring(0,100)}..."`),c[1].trim()):(v(`[Study Assist] Cleaned question text (table detected): "${e.substring(0,50)}..." \u2192 "${r.substring(0,100)}..."`),r)}}return e}async function ae(e=0){if(o.isActive)return o.detectedQuestions=[],await We(),o.detectedQuestions.length===0&&Ue(),o.detectedQuestions.length===0&&Xe(),{found:o.detectedQuestions.length>0,count:o.detectedQuestions.length,retryCount:e}}async function We(){let e=document.querySelectorAll(".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect");if(e.length!==0)for(let[t,s]of Array.from(e).entries())if(s.classList.contains("match")){let n=await Te(s);n&&(n.id=`moodle-q-${t}`,o.detectedQuestions.push(n))}else if(s.classList.contains("shortanswer")){let n=await j(s,"short-answer");n&&(n.id=`moodle-q-${t}`,o.detectedQuestions.push(n))}else if(s.classList.contains("numerical")){let n=await j(s,"numerical");n&&(n.id=`moodle-q-${t}`,o.detectedQuestions.push(n))}else if(s.classList.contains("gapselect")){let n=await Ae(s);n&&(n.id=`moodle-q-${t}`,o.detectedQuestions.push(n))}else{let n=await Ee(s);n&&o.detectedQuestions.push({id:`moodle-q-${t}`,element:s,text:n.text,type:n.type,options:n.options,questionNumber:n.questionNumber,images:n.images,confidence:95,platform:"moodle",courseName:n.courseName})}}function Ue(){let e=ve(),t=T("mcq-view");if(t.length>0&&(t.forEach((p,g)=>{let u=p.shadowRoot;if(!u)return;let d="",m=T(".mcq__body-inner",u);if(m.length>0){let E=m[0].textContent?.trim()||"";d=ne(E)}if(!d){let E=T(".mcq__header, .component__body",u);if(E.length>0){let w=E[0].textContent?.trim()||"";d=ne(w)}}if(!d){d=J(p);let E=d.split(`
`).filter(w=>w.trim().length>10);E.length>0&&(d=E[0].trim())}let h=T(".mcq__item-text-inner",u),b=[];h.forEach((E,w)=>{let k=E.textContent?.trim()||"";k&&k.length>0&&b.push({letter:String.fromCharCode(65+w),text:k})});let y=g+1,q=J(p).match(/pregunta\s*(\d+)/i);q&&(y=parseInt(q[1])),b.length>=2&&o.detectedQuestions.push({id:`q-${g}`,questionNumber:y,element:p,text:d||`Question ${y}`,type:"multiple-choice",options:b,confidence:95})}),o.detectedQuestions.length>0))return;let s=T(".mcq__item-text-inner");if(s.length>0){let p=new Map;s.forEach(u=>{let d=u;for(;d&&d.tagName!=="MCQ-VIEW";)d=d.parentElement||d.host;d&&(p.has(d)||p.set(d,[]),p.get(d).push(u.textContent?.trim()||""))});let g=0;if(p.forEach((u,d)=>{let m=T(".mcq__body-inner",d.shadowRoot||d)[0],h=m?m.textContent?.trim()||`Question ${g+1}`:`Question ${g+1}`,b=ne(h),y=u.map((x,q)=>({letter:String.fromCharCode(65+q),text:x}));y.length>=2&&(o.detectedQuestions.push({id:`q-${g}`,element:d,text:b,type:"multiple-choice",options:y,confidence:90}),g++)}),o.detectedQuestions.length>0)return}let n=new Set;document.querySelectorAll("*").forEach(p=>{p.className&&typeof p.className=="string"&&p.className.split(/\s+/).forEach(g=>{g.length>0&&n.add(g)})});let i=Array.from(n).filter(p=>/mcq|question|answer|option|choice|radio|check|select|quiz|item/i.test(p)),a=document.querySelectorAll('input[type="radio"], input[type="checkbox"]');if(a.length>=2){let p=new Map;a.forEach(u=>{let d=u.name||u.id||"unnamed";p.has(d)||p.set(d,[]),p.get(d).push(u)});let g=0;if(p.forEach((u,d)=>{if(u.length>=2){let m=u[0].closest('form, fieldset, [role="group"], [role="radiogroup"]');if(!m){m=u[0].parentElement;for(let h=0;h<10&&!(!m||!m.parentElement||u.every(y=>m.contains(y))&&m.innerText&&m.innerText.length>50);h++)m=m.parentElement}if(m){let h=u.map((x,q)=>{let E="",w=x.closest("label")||document.querySelector(`label[for="${x.id}"]`);return w?E=w.innerText?.trim()||"":E=x.parentElement?.innerText?.trim()||"",{letter:String.fromCharCode(65+q),text:E}}).filter(x=>x.text.length>0),y=m.innerText||"";h.forEach(x=>{y=y.replace(x.text,"")}),y=y.replace(/\s+/g," ").trim(),y.length>10&&h.length>=2&&(o.detectedQuestions.push({id:`q-${g}`,element:m,text:y.substring(0,500),type:"multiple-choice",options:h,confidence:85}),g++)}}}),o.detectedQuestions.length>0)return}let r=document.querySelectorAll('.mcq__item-text, .mcq__item-text-inner, [class*="mcq__"], [class*="mcq-"]');if(r.length>0){let p=new Set;r.forEach(u=>{let d=u;for(let m=0;m<15&&d.parentElement;m++){d=d.parentElement;let h=d.querySelectorAll('.mcq__item, [class*="mcq__item"]').length,b=d.innerText||"";if(h>=2&&b.length>50&&b.length<5e3&&/\?|pregunta|qué|cuál|cómo|dónde|which|what|how|where/i.test(b)){p.add(d);break}}});let g=0;if(p.forEach(u=>{let d=Ze(u);d&&(o.detectedQuestions.push({id:`q-${g}`,element:u,text:d.questionText,type:"multiple-choice",options:d.options,confidence:90}),g++)}),o.detectedQuestions.length>0)return}let c=document.body.querySelectorAll("*"),l=[];c.forEach(p=>{let g=p.textContent||"";if(/pregunta\s*\d+/i.test(g)&&g.length<500){let u=p;for(;u.parentElement&&u.parentElement!==document.body;){let d=u.parentElement.textContent||"";if(/radio_button|checkbox/i.test(d)||u.parentElement.querySelectorAll('input[type="radio"]').length>0){u=u.parentElement;break}if(d.length>3e3)break;u=u.parentElement}l.includes(u)||l.push(u)}});let f=document.body.innerText||"";if(/radio_button_(?:checked|unchecked)/i.test(f)){let p=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),g,u=new Set;for(;g=p.nextNode();)if(/radio_button/i.test(g.textContent||"")){let d=g.parentElement;for(let m=0;m<10&&d;m++){if(/pregunta/i.test(d.textContent||"")){u.add(d);break}d=d.parentElement}}u.forEach(d=>{l.includes(d)||l.push(d)})}l.forEach((p,g)=>{let u=F(p);if(u&&u.length>30){let d=Ge(u,p);o.detectedQuestions.push({id:`q-${g}`,element:p,text:u,type:"multiple-choice",options:d,confidence:80})}})}function Ge(e,t){let s=[],n=e.split(/radio_button_(?:checked|unchecked)/i);return n.length>1&&n.slice(1).forEach((i,a)=>{let r=i.trim().split(`
`)[0].trim();r&&r.length>2&&s.push({letter:String.fromCharCode(65+a),text:r})}),s}function Ze(e){let t=[],s=e.querySelectorAll('.mcq__item, [class*="mcq__item"]');s.length===0?e.querySelectorAll(".mcq__item-text, .mcq__item-text-inner").forEach((a,r)=>{let c=a.innerText?.trim();c&&c.length>1&&t.push({letter:String.fromCharCode(65+r),text:c})}):s.forEach((i,a)=>{let c=(i.querySelector(".mcq__item-text-inner, .mcq__item-text")||i).innerText?.trim();c&&c.length>1&&t.push({letter:String.fromCharCode(65+a),text:c})});let n=e.innerText||"";return t.forEach(i=>{n=n.replace(i.text,"")}),n=n.replace(/radio_button_(?:checked|unchecked)/gi,"").replace(/\s+/g," ").trim(),n.length<10||t.length<2?null:{questionText:n,options:t}}function Xe(){let e=document.querySelectorAll('p, div, span, li, td, th, label, h1, h2, h3, h4, h5, h6, article, section, blockquote, .question, .quiz-question, [class*="question"], [class*="quiz"], [class*="exam"], [data-question], [role="listitem"]'),t=new Set;e.forEach((s,n)=>{let i=F(s);if(!i||i.length<20||t.has(i)||we(s,o.detectedQuestions))return;let a=Ke(i,s);a.isQuestion&&(t.add(i),o.detectedQuestions.push({id:`q-${o.detectedQuestions.length}`,element:s,text:i,type:a.type,options:a.options,confidence:a.confidence}))})}function Ke(e,t){let s=!1,n="unknown",i=[],a=0;V.questionMarkers.test(e)&&(a+=30);for(let f of V.multipleChoice)if(f.test(e)){n="multiple-choice",a+=40,i=Ye(e,t);break}if(n==="unknown"){for(let f of V.trueFalse)if(f.test(e)){n="true-false",a+=35,i=["True","False"];break}}if(n==="unknown"){for(let f of V.fillBlank)if(f.test(e)){n="fill-blank",a+=30;break}}let r=(t.className||"").toString().toLowerCase(),c=Array.from(t.attributes).map(f=>f.name.toLowerCase()).join(" ");return/question|quiz|exam|test|assessment/i.test(r+" "+c)&&(a+=25),t.querySelectorAll('input[type="radio"], input[type="checkbox"]').length>0&&(n=n==="unknown"?"multiple-choice":n,a+=35,i.length===0&&(i=Je(t))),s=a>=40,{isQuestion:s,type:n,options:i,confidence:a}}function Ye(e,t){let s=[],n=/(?:^|\n)\s*([A-Da-d])[\.\)\:]?\s*([^\n]+)/gm,i;for(;(i=n.exec(e))!==null;)s.push({letter:i[1].toUpperCase(),text:i[2].trim()});if(s.length===0){let a=/\(([A-Da-d])\)\s*([^\n\(]+)/gm;for(;(i=a.exec(e))!==null;)s.push({letter:i[1].toUpperCase(),text:i[2].trim()})}if(s.length===0){let a=/(?:^|\n)\s*([1-4])[\.\)\:]?\s*([^\n]+)/gm;for(;(i=a.exec(e))!==null;)s.push({letter:i[1],text:i[2].trim()})}return s}function Je(e){let t=[];return e.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((n,i)=>{let a=e.querySelector(`label[for="${n.id}"]`)||n.closest("label"),r=a?F(a):n.value||`Option ${i+1}`;t.push({letter:String.fromCharCode(65+i),text:(r||"").replace(/^[A-Da-d][\.\)\:]\s*/,"").trim()})}),t}function D(){let e=T("mcq-view"),t=T("object-matching-view"),s=T("matching-view");return e.length>0||t.length>0||s.length>0||document.querySelectorAll(".que.multichoice, .que.truefalse, .que.shortanswer, .que.numerical, .que.essay, .que.match, .que.gapselect").length>0}function W(e,t=10,s=500){let n=0;function i(){n++,D()?e(!0):n<t?setTimeout(i,s):e(!1)}i()}function re(){let e=[];function t(s){let n=document.createTreeWalker(s,NodeFilter.SHOW_TEXT),i;for(;i=n.nextNode();)if(i.textContent&&/pregunta\s*\d+/i.test(i.textContent)){let r=i.textContent.match(/pregunta\s*(\d+)/i);if(r){let c=parseInt(r[1]),l=i.parentElement;if(l){let f=l.getBoundingClientRect();if(f.top>=-100&&f.top<=window.innerHeight&&f.width>0&&f.height>0){let p=parseFloat(window.getComputedStyle(l).fontSize)||12,g=f.width*f.height,u=Math.abs(f.left+f.width/2-window.innerWidth/2),d=p*10+g/100-u/10;e.push({num:c,top:f.top,fontSize:p,area:g,score:d,text:i.textContent.trim()})}}}}s.querySelectorAll("*").forEach(r=>{r.shadowRoot&&t(r.shadowRoot)})}return t(document),e.length===0?null:(e.sort((s,n)=>n.score-s.score),e[0].num)}async function C(){let e=await et();if(e)return e;let t=re(),s=tt();if(v("[Study Assist] detectVisibleQuestion:",{visibleQuestionNum:t,questionMapKeys:Object.keys(s),questionMapDetails:Object.entries(s).map(([a,r])=>({num:a,type:r.question?.type,score:r.score,text:r.question?.text?.substring(0,50)}))}),t!==null&&s[t])return s[t].question;let n=null,i=-1/0;for(let a in s){let r=s[a];r.score>i&&(i=r.score,n=r)}return n?n.question:null}async function et(){let e=document.querySelectorAll(".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect");if(e.length===0)return null;let t=window.innerHeight/2,s=null,n=-1/0;for(let i of e){let a=i.getBoundingClientRect();if(a.width===0||a.height===0||!(a.top<window.innerHeight&&a.bottom>0))continue;let l=1e4-Math.abs((a.top+a.bottom)/2-t);l>n&&(n=l,s=i)}return s||(s=e[0]??null),s?await oe(s):null}async function oe(e){return e.classList.contains("match")?await Te(e):e.classList.contains("shortanswer")?await j(e,"short-answer"):e.classList.contains("numerical")?await j(e,"numerical"):e.classList.contains("gapselect")?await Ae(e):await Ee(e)}async function le(){let e=document.querySelectorAll(".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect");if(e.length===0)return[];let t=[],s=!1;for(let i of e){let a=i.getBoundingClientRect();a.width===0||a.height===0||(s=!0,!(a.top<window.innerHeight&&a.bottom>0))||t.push({el:i,top:a.top})}if(!s){let i=[];for(let a of e){let r=await oe(a);r&&i.push(r)}return i}t.sort((i,a)=>i.top-a.top);let n=[];for(let{el:i}of t){let a=await oe(i);a&&n.push(a)}return n}function U(){let e=document.getElementById("coursetitle");if(e){let i=e.textContent?.trim();if(i&&i.length>2)return i}let t=document.querySelectorAll('.breadcrumb a[href*="/course/view.php"]');for(let i of t){let a=i.getAttribute("title");if(a&&a.length>2)return a;let r=i.querySelector('span[itemprop="title"]');if(r){let c=r.textContent?.trim();if(c&&c.length>2)return c}}let s=document.title.trim(),n=s.lastIndexOf(":");if(n!==-1&&n<s.length-1){let i=s.substring(n+1).trim();if(i.length>3)return i}}async function Ee(e){let t=U(),s=e.classList.contains("truefalse"),n=e.querySelector(".qno"),i=n?parseInt(n.textContent?.trim()||"1"):1,a=e.querySelector(".qtext"),r="",c=[];if(a){r=a.textContent?.trim()||"";let g=a.querySelectorAll("img:not(.questionflagimage)");for(let u of g)if(!(u.width<50||u.height<50))if(I(u.src))c.push({url:u.src,mediaType:"image/jpeg",alt:u.alt||"Question image",location:"question"});else{let d=await B(u);d&&c.push({base64:d.base64,mediaType:d.mediaType,alt:u.alt||"Question image",location:"question"})}}let l=e.querySelector(".answer"),f=[];if(l){let g=l.querySelectorAll(":scope > div.r0, :scope > div.r1");for(let u of g){let d=u.querySelector(".answernumber"),m="";d&&(m=(d.textContent?.trim()||"").replace(".","").toUpperCase());let h=u.querySelector(".flex-fill, [data-region='answer-label'] > div:not(.answernumber)"),b="",y=null;if(h){b=h.textContent?.trim()||"";let x=h.querySelector("img:not(.questionflagimage)");if(x&&x.width>=50&&x.height>=50)if(I(x.src))y={url:x.src,mediaType:"image/jpeg",alt:x.alt||`Option ${m} image`};else{let q=await B(x);q&&(y={base64:q.base64,mediaType:q.mediaType,alt:x.alt||`Option ${m} image`})}}else{let x=u.querySelector("[data-region='answer-label']");if(x){b=x.textContent?.trim()||"",d&&(b=b.replace(d.textContent||"","").trim());let q=x.querySelector("img:not(.questionflagimage)");if(q&&q.width>=50&&q.height>=50)if(I(q.src))y={url:q.src,mediaType:"image/jpeg",alt:q.alt||`Option ${m} image`};else{let E=await B(q);E&&(y={base64:E.base64,mediaType:E.mediaType,alt:q.alt||`Option ${m} image`})}}}if(!b){let x=u.querySelector("label");x&&(b=x.textContent?.trim()||"")}if(b||(b=u.textContent?.trim()||"",d&&d.textContent&&(b=b.replace(d.textContent,"").trim())),s){let x=b.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();/(^|\b)(true|verdadero)(\b|$)/i.test(x)?m="V":/(^|\b)(false|falso)(\b|$)/i.test(x)&&(m="F")}m||(m=String.fromCharCode(65+f.length)),(b||y)&&f.push({letter:m,text:b||`[Image: ${y?.alt||"option"}]`,image:y})}}return!(r||c.length>0)||f.length<2?null:{id:`moodle-q-${i}`,type:s?"true-false":"multiple-choice",text:r,options:f,element:e,questionNumber:i,platform:"moodle",images:c,confidence:95,courseName:t}}async function Te(e){let t=U(),s=e.querySelector(".qno"),n=s?parseInt(s.textContent?.trim()||"1"):1,a=(e.querySelector(".qtext")?.textContent||"").replace(/\s+/g," ").trim();if(!a)return null;let r=e.querySelectorAll("table.answer tbody tr");if(r.length===0)return null;let c=[],l=null;for(let[f,p]of Array.from(r).entries()){let u=(p.querySelector("td.text")?.textContent||"").replace(/\s+/g," ").trim();if(u&&c.push({letter:String.fromCharCode(65+f),text:u}),!l){let d=p.querySelector("td.control select");if(d){l=[];for(let m of Array.from(d.querySelectorAll("option"))){let h=parseInt(m.getAttribute("value")||"0");h>0&&l.push({index:h,text:(m.textContent||"").replace(/\s+/g," ").trim()})}}}}return c.length===0||!l||l.length===0?null:{id:`moodle-q-${n}`,type:"matching",text:a,options:[],element:e,questionNumber:n,platform:"moodle",confidence:95,courseName:t,categories:c,matchingOptions:l}}async function j(e,t){let s=U(),n=e.querySelector(".qno"),i=n?parseInt(n.textContent?.trim()||"1"):1,r=e.querySelector(".qtext")?.textContent?.trim()||"";return r?{id:`moodle-q-${i}`,type:t,text:r,options:[],element:e,questionNumber:i,platform:"moodle",confidence:95,courseName:s}:null}async function Ae(e){let t=U(),s=e.querySelector(".qno"),n=s?parseInt(s.textContent?.trim()||"1"):1,i=e.querySelector(".qtext");if(!i)return null;let a=Array.from(i.querySelectorAll("select"));if(a.length===0)return null;let r=i.cloneNode(!0),c=Array.from(r.querySelectorAll("select")),l=[],f={},p=new Map,g=0;for(let d=0;d<a.length;d++){let m=a[d],h=c[d],b=d+1,y=[];for(let E of Array.from(m.querySelectorAll("option")))parseInt(E.getAttribute("value")||"0")>0&&y.push(E.textContent?.trim()||"");let x=y.join("|"),q;p.has(x)?q=p.get(x):(q=String.fromCharCode(65+g),g++,p.set(x,q),f[q]=y),h.replaceWith(`[[${b}]]`),l.push({index:b,groupId:q,leftContext:"",rightContext:""})}let u=(r.textContent||"").replace(/\s+/g," ").trim();for(let d of l){let m=`[[${d.index}]]`,h=u.indexOf(m);h!==-1&&(d.leftContext=u.substring(0,h).slice(-60).trim(),d.rightContext=u.substring(h+m.length,h+m.length+60).trim())}return!u||l.length===0?null:{id:`moodle-q-${n}`,type:"select-missing-words",text:u,options:[],element:e,questionNumber:n,platform:"moodle",confidence:95,courseName:t,selectGaps:l,selectChoices:f}}function tt(){let e={},t=window.innerHeight/2,s=window.innerWidth/2,n=1e6,i=T("mcq-view"),a=T("object-matching-view"),r=T("matching-view");for(let c of i){let l=c.getBoundingClientRect();if(!(l.width>0&&l.height>0))continue;let p=ie(c);if(p===null)continue;let u=1e4-Math.sqrt(Math.pow(l.left+l.width/2-s,2)+Math.pow(l.top+l.height/2-t,2)),d=it(c,p);!d||d.options.length<2||(!e[p]||e[p].score<u)&&(e[p]={type:"mcq",question:d,score:u,element:c})}for(let c of a){let l=c.getBoundingClientRect();if(!(l.width>0&&l.height>0))continue;let p=ie(c),g=p!==null?p:n++,d=1e4-Math.sqrt(Math.pow(l.left+l.width/2-s,2)+Math.pow(l.top+l.height/2-t,2)),m=st(c,g);m&&(!e[g]||e[g].score<d)&&(e[g]={type:"matching",question:m,score:d,element:c})}for(let c of r){let l=c.getBoundingClientRect();if(!(l.width>0&&l.height>0))continue;let p=ie(c),g=p!==null?p:n++,d=1e4-Math.sqrt(Math.pow(l.left+l.width/2-s,2)+Math.pow(l.top+l.height/2-t,2)),m=nt(c,g);m&&(!e[g]||e[g].score<d)&&(e[g]={type:"matching",question:m,score:d,element:c})}return e}function ie(e){let t=e.parentElement||e.getRootNode()?.host,s=0,n=15;for(;t&&s<n;){let f=t.children;for(let u of f){if(u===e)continue;let m=(u.textContent||"").match(/pregunta\s*(\d+)/i);if(m)return parseInt(m[1]);if(u.shadowRoot){let b=(u.shadowRoot.textContent||"").match(/pregunta\s*(\d+)/i);if(b)return parseInt(b[1])}}let g=be(t).match(/pregunta\s*(\d+)/i);if(g)return parseInt(g[1]);if(t.shadowRoot){let d=(t.shadowRoot.textContent||"").match(/pregunta\s*(\d+)/i);if(d)return parseInt(d[1])}if(t.parentElement)t=t.parentElement;else if(t.getRootNode()?.host)t=t.getRootNode().host;else break;s++}if(e.shadowRoot){let p=(e.shadowRoot.textContent||"").match(/pregunta\s*(\d+)/i);if(p)return parseInt(p[1])}let i=e.getBoundingClientRect();if(i.width===0||i.height===0)return null;let a=[];function r(f){let p=document.createTreeWalker(f,NodeFilter.SHOW_TEXT),g;for(;g=p.nextNode();)if(g.textContent&&/pregunta\s*\d+/i.test(g.textContent)){let d=g.textContent.match(/pregunta\s*(\d+)/i);if(d&&g.parentElement){let m=g.parentElement.getBoundingClientRect();m.width>0&&m.height>0&&a.push({num:parseInt(d[1]),rect:m,element:g.parentElement})}}f.querySelectorAll("*").forEach(d=>{d.shadowRoot&&r(d.shadowRoot)})}r(document);let c=null,l=1/0;for(let f of a){let p=i.top-f.rect.bottom,g=Math.abs(i.left+i.width/2-(f.rect.left+f.rect.width/2));if(p>=-50&&p<500){let u=Math.abs(p)+g*.5;u<l&&(l=u,c=f)}}return c?c.num:null}function st(e,t){let s=e.shadowRoot;if(!s)return null;let n="",i=T(".component__body-inner, .objectMatching__body-inner",s);i.length>0&&(n=i[0].textContent?.trim()||"");let a=T("object-matching-dropdown-view",s);if(a.length>0){let p=[],g=new Set;a.forEach((d,m)=>{let h=d.shadowRoot;if(!h)return;let b=h.querySelector(".category-item-number"),y=h.querySelector(".matching__item-title_inner");if(y){let E=b&&b.textContent?.trim()||String.fromCharCode(65+m),w=y.textContent?.trim()||"";w&&!w.includes("objetivo dejado en blanco")&&p.push({letter:E,text:w})}if(h.querySelector(".dropdown__btn")){let E=h.querySelector(".dropdown__inner")?.textContent?.trim();E&&!E.includes("s\xE9lectionner")&&!E.includes("Seleccione")&&!E.includes("Select")&&g.add(E)}h.querySelectorAll(".dropdown__item-inner").forEach(E=>{let w=E.textContent?.trim();w&&!w.includes("s\xE9lectionner")&&!w.includes("Seleccione")&&!w.includes("Select")&&g.add(w)})});let u=Array.from(g).map((d,m)=>({index:m+1,text:d}));if(p.length>=2)return{id:`matching-${t}`,type:"matching",matchingStyle:"object-dropdown",questionNumber:t,text:n||`Pregunta ${t||"?"}`,categories:p,matchingOptions:u.length>0?u:[{index:1,text:"(options in dropdown)"}],element:e,options:[],confidence:95}}let r=[];T(".objectMatching-category-item",s).forEach((p,g)=>{let u=p.querySelector(".category-item-text"),d=p.querySelector(".category-item-number");if(u){let m=u.textContent?.trim()||"",h=d&&d.textContent?.trim()||String.fromCharCode(65+g);r.push({letter:h,text:m})}});let l=[];return T(".objectMatching-option-item",s).forEach((p,g)=>{let u=p.querySelector(".category-item-text");if(u){let d=u.textContent?.trim()||"";l.push({index:g+1,text:d})}}),r.length>=2&&l.length>=2?{id:`matching-${t}`,type:"matching",questionNumber:t,text:n||`Pregunta ${t||"?"}`,categories:r,matchingOptions:l,element:e,options:[],confidence:95}:null}function nt(e,t){let s=e.shadowRoot;if(!s)return null;let n="",i=T(".component__body-inner, .matching__body-inner",s);i.length>0&&(n=i[0].textContent?.trim()||"");let a=[],r=new Set;T("matching-dropdown-view",s).forEach((f,p)=>{let g=f.shadowRoot;if(!g)return;let u=g.querySelector(".matching__item-title_inner");if(u){let m=u.textContent?.trim()||"";a.push({index:p+1,text:m})}g.querySelectorAll(".dropdown__item-inner").forEach(m=>{let h=m.textContent?.trim();h&&h!=="Seleccione una opci\xF3n"&&r.add(h)})});let l=Array.from(r).map((f,p)=>({letter:String.fromCharCode(65+p),text:f}));return a.length>=2&&l.length>=1?{id:`matching-dropdown-${t}`,type:"matching",matchingStyle:"dropdown",questionNumber:t,text:n||`Pregunta ${t||"?"}`,categories:l,matchingOptions:a,element:e,options:[],confidence:95}:null}function it(e,t){let s=e.shadowRoot;if(!s)return null;let n="",i=T(".mcq__body-inner",s);i.length>0&&(n=i[0].textContent?.trim()||"");let a="";if(a=H(s),!a){let l=e.parentElement,f=0;for(;l&&f<10&&(a=H(l),!(a||l.shadowRoot&&(a=H(l.shadowRoot),a)));){if(l.tagName&&(l.tagName.toLowerCase().includes("block-view")||l.tagName.toLowerCase().includes("tabs-view")||l.classList?.contains("component__container"))){let p=l.querySelectorAll("*");for(let g of p)if(g.shadowRoot&&(a=H(g.shadowRoot),a))break;if(a)break}l=l.parentElement,f++}}a||(v("[Study Assist] Searching entire document for diagram descriptions..."),a=H(document.body)),a&&(v("[Study Assist] Adding diagram description to question context"),n=n+`

[DIAGRAM DESCRIPTION]
`+a);let r=T(".mcq__item-text-inner",s),c=[];return r.forEach((l,f)=>{let p=l.textContent?.trim()||"";p&&p.length>0&&c.push({letter:String.fromCharCode(65+f),text:p})}),c.length<2?null:{id:`mcq-${t}`,type:"multiple-choice",questionNumber:t,text:n||`Pregunta ${t||"?"}`,options:c,element:e,confidence:95}}function Ce(e){let{frameHasQuizContent:t,waitForQuizContent:s,handleQuickClick:n}=e,i=document.getElementById("study-assist-overlay");i&&i.remove();let a=document.getElementById("study-assist-quick-container");a&&a.remove();let r=document.getElementById("study-assist-quick");r&&r.remove(),o.settings.quickMode?t&&t()?L({handleQuickClick:n}):s&&s(c=>{c&&L({handleQuickClick:n})}):ot(e.showQuestionsSummary)}function ot(e){let t=document.createElement("div");t.id="study-assist-overlay",t.innerHTML=`
    <div class="study-assist-header">
      <span class="study-assist-logo">SA</span>
      <div class="study-assist-controls">
        <button class="study-assist-refresh" title="Volver a detectar pregunta">\u21BB</button>
        <button class="study-assist-minimize" title="Minimizar">\u2212</button>
        <button class="study-assist-close" title="Cerrar">\xD7</button>
      </div>
    </div>
    <div class="study-assist-content">
      <div class="study-assist-loading" style="display: none;">
        <div class="study-assist-spinner"></div>
        <span>Analizando...</span>
      </div>
      <div class="study-assist-results"></div>
    </div>
  `,document.body.appendChild(t);let s=t.querySelector(".study-assist-close");s&&s.addEventListener("click",O);let n=t.querySelector(".study-assist-minimize");if(n&&n.addEventListener("click",at),e){let i=t.querySelector(".study-assist-refresh");i&&i.addEventListener("click",e)}rt(t)}function ce(){let e=document.getElementById("study-assist-overlay");e&&(e.classList.add("study-assist-visible"),o.overlayVisible=!0)}function O(){let e=document.getElementById("study-assist-overlay");e&&(e.classList.remove("study-assist-visible"),o.overlayVisible=!1)}function at(){let e=document.getElementById("study-assist-overlay");e&&e.classList.toggle("study-assist-minimized")}function rt(e){let t=e.querySelector(".study-assist-header");if(!t)return;let s=!1,n,i,a,r;t.addEventListener("mousedown",c=>{c.target.tagName!=="BUTTON"&&(s=!0,a=c.clientX-(e.offsetLeft||0),r=c.clientY-(e.offsetTop||0))}),document.addEventListener("mousemove",c=>{s&&(c.preventDefault(),n=c.clientX-a,i=c.clientY-r,e.style.left=`${n}px`,e.style.top=`${i}px`,e.style.right="auto",e.style.bottom="auto")}),document.addEventListener("mouseup",()=>{s=!1})}function Me(){v("[Study Assist] ALT+Q pressed - toggling SA button visibility");let e=document.getElementById("study-assist-quick-container");if(e){let t=e.style.display==="none";e.style.display=t?"":"none",o.saButtonHidden=!t;try{chrome.runtime.sendMessage({type:"SET_CONTENT_PREFERENCE",enabled:o.saButtonHidden}).catch(()=>{})}catch{}v(`[Study Assist] SA button ${t?"shown":"hidden"}, CTRL webex toggle ${t?"enabled":"disabled"}`)}else v("[Study Assist] SA button container not found")}function G(){let e=document.getElementById("study-assist-quick"),t=document.getElementById("study-assist-quick-container");e&&(e.innerHTML="<span>SA</span>",e.classList.remove("has-answer","matching-answer","multi-answer","multi-answer-large")),t&&t.classList.remove("matching-mode"),o.lastAnsweredQuestionNum=null,o.hasValidAnswer=!1}function L(e){let{handleQuickClick:t}=e,s=document.createElement("div");s.id="study-assist-quick-container";let n=o.settings.buttonPosition||"bottom-right";s.setAttribute("data-position",n);let i=document.createElement("div");i.id="study-assist-quick",i.innerHTML="<span>SA</span>",s.appendChild(i),document.body.appendChild(s),o.saButtonHidden&&(s.style.display="none"),t&&i.addEventListener("click",a=>{a.isTrusted&&o.isActive&&o.isDomainAllowed&&t(a)}),lt()}function lt(){let e="study-assist-webex-hide-style",t=window.self===window.top;if(document.getElementById(e))return;let s=document.createElement("style");s.id=e,s.textContent=`
    /* Class to hide Webex button */
    .webex-hidden-by-sa {
      visibility: hidden !important;
    }
    /* Set Webex button icon size */
    .fabActionBtnIconContainer--RPrZH img {
      width: 65px !important;
      height: 65px !important;
    }
  `,document.head.appendChild(s);let n=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");n&&a(n),new MutationObserver(l=>{l.forEach(f=>{f.addedNodes.forEach(p=>{if(p.nodeType===Node.ELEMENT_NODE){let g=p;(g.id==="webexFabActionBtn"||g.classList.contains("fabActionBtn--WND8X"))&&a(g);let u=g.querySelector?.("#webexFabActionBtn, .fabActionBtn--WND8X");u&&a(u)}})})}).observe(document.body,{childList:!0,subtree:!0});function a(l){if(!l)return;let f=l.querySelector(".fabActionBtnIconContainer--RPrZH img");f&&(f.style.setProperty("width","55px","important"),f.style.setProperty("height","55px","important"))}function r(){let l=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");l&&l.classList.add("webex-hidden-by-sa")}function c(){let l=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");l&&l.classList.remove("webex-hidden-by-sa")}t&&window.addEventListener("message",l=>{l.data==="study-assist-hide-webex"?r():l.data==="study-assist-show-webex"&&c()}),document.addEventListener("keydown",l=>{if(l.key==="Control"&&(r(),!t))try{window.parent.postMessage("study-assist-hide-webex","*")}catch{}}),document.addEventListener("keyup",l=>{if(l.key==="Control"&&(c(),!t))try{window.parent.postMessage("study-assist-show-webex","*")}catch{}})}function Z(e){R(),o.detectedQuestions.forEach((t,s)=>{let n=t.element;n.classList.add("study-assist-question-highlight"),n.dataset.studyAssistId=t.id;let i=document.createElement("div");i.className="study-assist-question-badge",i.textContent=String(s+1),i.title=`Pregunta ${s+1} - Clic para analizar`,i.addEventListener("click",a=>{!a.isTrusted||!o.isActive||!o.isDomainAllowed||(a.stopPropagation(),e&&e(t))}),n.style.position=n.style.position||"relative",n.appendChild(i)})}function R(){document.querySelectorAll(".study-assist-question-highlight").forEach(e=>{e.classList.remove("study-assist-question-highlight"),delete e.dataset.studyAssistId}),document.querySelectorAll(".study-assist-question-badge").forEach(e=>{e.remove()})}function Se(e,t){let s=document.getElementById("study-assist-overlay");if(!s)return;let n=s.querySelector(".study-assist-results");if(!n)return;let i;if(e.type==="matching"){let r=(e.categories||[]).map(l=>`<div class="study-assist-matching-item"><strong>${l.letter}.</strong> ${S(l.text)}</div>`).join(""),c=(e.matchingOptions||[]).map(l=>`<div class="study-assist-matching-item"><strong>${l.index}.</strong> ${S(l.text)}</div>`).join("");i=`
      <div class="study-assist-single-question">
        ${e.questionNumber?`<div class="study-assist-question-label">Pregunta ${e.questionNumber}</div>`:""}
        <div class="study-assist-question-box">
          <p>${S(e.text)}</p>
          <div class="study-assist-matching-container">
            <div class="study-assist-matching-section">
              <h5>Categor\xEDas:</h5>
              <div class="study-assist-matching-items">
                ${r}
              </div>
            </div>
            <div class="study-assist-matching-section">
              <h5>Opciones:</h5>
              <div class="study-assist-matching-items">
                ${c}
              </div>
            </div>
          </div>
        </div>
        <button class="study-assist-analyze-btn-large">Analizar Pregunta</button>
      </div>
    `}else{let r=(e.options||[]).map(c=>`<div class="study-assist-option-item"><strong>${c.letter}.</strong> ${S(c.text)}</div>`).join("");i=`
      <div class="study-assist-single-question">
        ${e.questionNumber?`<div class="study-assist-question-label">Pregunta ${e.questionNumber}</div>`:""}
        <div class="study-assist-question-box">
          <p>${S(e.text)}</p>
          <div class="study-assist-options">
            ${r}
          </div>
        </div>
        <button class="study-assist-analyze-btn-large">Analizar Pregunta</button>
      </div>
    `}n.innerHTML=i,o.currentVisibleQuestion=e;let a=n.querySelector(".study-assist-analyze-btn-large");a&&a.addEventListener("click",r=>{!r.isTrusted||!o.isActive||!o.isDomainAllowed||t&&t(e)}),ce()}async function ke(e,t){if(!document.getElementById("study-assist-overlay"))return;let n=await e();if(n){Se(n,t);return}let i=null,a=-1;if(o.detectedQuestions.forEach(r=>{let c=xe(r.element);c>a&&(a=c,i=r)}),!i&&o.detectedQuestions.length>0&&(i=o.detectedQuestions[0]),i){Se(i,t);return}ct()}function ct(){let e=document.getElementById("study-assist-overlay");if(!e||!o.overlayVisible)return;let t=e.querySelector(".study-assist-results");t&&(t.innerHTML=`
    <div class="study-assist-empty">
      <p>No se detect\xF3 una pregunta. Haz clic en \u21BB para reintentar.</p>
    </div>
  `)}function Le(){let e=document.getElementById("study-assist-overlay");if(!e)return;let t=e.querySelector(".study-assist-loading");t&&(t.style.display="flex")}function $(){let e=document.getElementById("study-assist-overlay");if(!e)return;let t=e.querySelector(".study-assist-loading");t&&(t.style.display="none")}function Qe(e,t,s){let n=document.getElementById("study-assist-overlay");if(!n)return;let i=n.querySelector(".study-assist-results");if(!i)return;i.innerHTML=`
    <div class="study-assist-analysis">
      <button class="study-assist-back-btn">\u2190 Volver a Preguntas</button>
      
      <div class="study-assist-question-box">
        <h4>\u{1F4DD} Pregunta</h4>
        <p>${S(ee(t.text,300))}</p>
        ${t.options&&t.options.length>0?`
          <div class="study-assist-options">
            ${t.options.map(r=>`
              <div class="study-assist-option">
                <span class="study-assist-option-letter">${r.letter}</span>
                <span>${S(r.text)}</span>
              </div>
            `).join("")}
          </div>
        `:""}
      </div>
      
      <div class="study-assist-answer-box">
        <h4>\u{1F393} Learning Guide</h4>
        <div class="study-assist-answer-content">
          ${te(e)}
        </div>
      </div>
      
      <div class="study-assist-disclaimer">
          \u26A0\uFE0F Esta es una ayuda de aprendizaje generada por IA. Verifica siempre la informaci\xF3n y \xFAsala para mejorar tu comprensi\xF3n, no como sustituto del estudio.
      </div>
    </div>
  `;let a=i.querySelector(".study-assist-back-btn");a&&a.addEventListener("click",()=>{s&&s()}),ce()}function X(e,t,s,n=!1,i){let a=document.getElementById("study-assist-overlay");if(!a)return;let r=a.querySelector(".study-assist-results");if(!r)return;if(n){r.innerHTML=`
      <div class="study-assist-analysis">
        <button class="study-assist-back-btn">\u2190 Volver a Preguntas</button>
        
        <div class="study-assist-question-box">
          <h4>\u{1F4DD} Pregunta</h4>
          <p>${S(ee(t.text,300))}</p>
          ${t.options&&t.options.length>0?`
            <div class="study-assist-options">
              ${t.options.map(f=>`
                <div class="study-assist-option">
                  <span class="study-assist-option-letter">${f.letter}</span>
                  <span>${S(f.text)}</span>
                </div>
              `).join("")}
            </div>
          `:""}
        </div>
        
        <div class="study-assist-answer-box">
          <h4>\u{1F393} Learning Guide</h4>
          <div class="study-assist-answer-content" id="study-assist-stream-content">
            <span class="study-assist-stream-cursor">\u258A</span>
          </div>
        </div>

        <div class="study-assist-token-info" id="study-assist-token-info" style="display:none;"></div>
        
        <div class="study-assist-disclaimer">
          \u26A0\uFE0F Esta es una ayuda de aprendizaje generada por IA. Verifica siempre la informaci\xF3n.
        </div>
      </div>
    `;let l=r.querySelector(".study-assist-back-btn");l&&l.addEventListener("click",()=>{s&&s()}),ce();return}let c=document.getElementById("study-assist-stream-content");if(c){let l=i?"":'<span class="study-assist-stream-cursor">\u258A</span>';c.innerHTML=te(e)+l,c.scrollTop=c.scrollHeight}if(i){let l=document.getElementById("study-assist-token-info");l&&(l.style.display="block",l.innerHTML=`
        <span title="Tokens de entrada">\u{1F4E5} ${i.inputTokens}</span>
        <span title="Tokens de salida">\u{1F4E4} ${i.outputTokens}</span>
        <span title="Costo estimado">\u{1F4B0} $${i.cost.toFixed(6)}</span>
      `)}}function de(e,t){let s=document.getElementById("study-assist-overlay");if(!s)return;let n=s.querySelector(".study-assist-results");if(!n)return;n.innerHTML=`
    <div class="study-assist-error">
      <span class="study-assist-error-icon">\u26A0\uFE0F</span>
      <h3>Error de An\xE1lisis</h3>
      <p>${S(e)}</p>
      <button class="study-assist-retry-btn">Reintentar</button>
    </div>
  `;let i=n.querySelector(".study-assist-retry-btn");i&&i.addEventListener("click",()=>{t&&t()})}function _e(e){dt(e)}function dt(e){let{triggerQuickAnalysis:t,reloadQuickMode:s,toggleSAButtonVisibility:n,cancelCurrentRequest:i}=e,a="study-assist-webex-hide-style",r="study-assist-keyboard-injected",c=window.self===window.top,l=document.documentElement.hasAttribute(r);if(!document.getElementById(a)){let m=document.createElement("style");m.id=a,m.textContent=`
    /* Class to hide Webex button */
    .webex-hidden-by-sa {
      visibility: hidden !important;
    }
    /* Set Webex button icon size */
    .fabActionBtnIconContainer--RPrZH img {
      width: 65px !important;
      height: 65px !important;
    }
  `,(document.head??document.documentElement).appendChild(m)}if(l)return;document.documentElement.setAttribute(r,"1");let f=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");f&&g(f),new MutationObserver(m=>{m.forEach(h=>{h.addedNodes.forEach(b=>{if(b.nodeType===Node.ELEMENT_NODE){let y=b;(y.id==="webexFabActionBtn"||y.classList.contains("fabActionBtn--WND8X"))&&g(y);let x=y.querySelector?.("#webexFabActionBtn, .fabActionBtn--WND8X");x&&g(x)}})})}).observe(document.body??document.documentElement,{childList:!0,subtree:!0});function g(m){if(!m)return;let h=m.querySelector(".fabActionBtnIconContainer--RPrZH img");h&&(h.style.setProperty("width","55px","important"),h.style.setProperty("height","55px","important"))}function u(){let m=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");m&&m.classList.add("webex-hidden-by-sa")}function d(){let m=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");m&&m.classList.remove("webex-hidden-by-sa")}c&&window.addEventListener("message",m=>{m.data==="study-assist-hide-webex"?u():m.data==="study-assist-show-webex"&&d()}),document.addEventListener("keydown",m=>{if(!(!m.isTrusted||!o.isActive||!o.isDomainAllowed)){if(m.key==="Control"){if(o.saButtonHidden)return;if(u(),!c)try{window.parent.postMessage("study-assist-hide-webex","*")}catch{}try{window.top?.postMessage("study-assist-hide-webex","*")}catch{}}if(m.altKey&&!m.repeat&&(m.key==="w"||m.key==="W")){let h=document.activeElement;!K(h)&&o.settings.quickMode&&(m.preventDefault(),s())}if(m.altKey&&!m.repeat&&(m.key==="q"||m.key==="Q")){let h=document.activeElement;K(h)||(m.preventDefault(),n())}if(m.altKey&&!m.repeat&&(m.key==="x"||m.key==="X")){let h=document.activeElement;!K(h)&&o.isRequestInProgress&&(m.preventDefault(),i())}if(m.key==="Shift"&&!m.repeat){let h=document.activeElement,b=K(h),y=document.getElementById("study-assist-quick"),x=y&&y.classList.contains("loading");!b&&y&&(m.preventDefault(),x&&m.ctrlKey?(v("[Study Assist] CTRL+SHIFT pressed while loading - cancelling current request"),chrome.runtime.sendMessage({type:"CANCEL_ANALYSIS",skipPrimary:!0}).then(q=>{q&&q.cancelled&&v("[Study Assist] Request cancelled, validator will take over")}).catch(q=>{v("[Study Assist] Cancel message error:",q)})):x||(o.skipPrimary=m.ctrlKey,o.skipPrimary&&v("[Study Assist] CTRL+SHIFT pressed - will skip primary, use validator directly"),t()))}}}),document.addEventListener("keyup",m=>{if(m.key==="Control"){if(o.saButtonHidden)return;if(d(),!c)try{window.parent.postMessage("study-assist-show-webex","*")}catch{}try{window.top?.postMessage("study-assist-show-webex","*")}catch{}}}),window.addEventListener("blur",()=>{d();try{window.top?.postMessage("study-assist-show-webex","*")}catch{}})}function K(e){return!!(e&&(e.tagName==="INPUT"||e.tagName==="TEXTAREA"||e.isContentEditable||e.closest('[contenteditable="true"]')))}function Q(){return document.getElementById("study-assist-qa-sandbox")!==null}function Ie(e,t=[]){let s=e.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();if(/\b(V|TRUE|VERDADERO)\b/.test(s))return"V";if(/\b(F|FALSE|FALSO)\b/.test(s))return"F";let n=s.match(/\b([A-Z])\b/)?.[1];if(n){let i=t.find(a=>a.letter.toUpperCase()===n);if(i){let a=i.text.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase();if(/\b(TRUE|VERDADERO)\b/.test(a))return"V";if(/\b(FALSE|FALSO)\b/.test(a))return"F"}}return"?"}var A=0,z=new Set,N=new Map;function pe(){v("[Study Assist] ALT+X pressed - cancelling current request"),A++;for(let t of N.values())t();N.clear(),z.clear();let e=document.getElementById("study-assist-quick");o.requestCancelled=!0,o.slowConnectionTimer&&(clearTimeout(o.slowConnectionTimer),o.slowConnectionTimer=null),e&&(e.innerHTML="<span>SA</span>",e.classList.remove("loading","slow-connection")),$(),o.isRequestInProgress=!1,v("[Study Assist] Request cancelled by user")}function De(e={detectVisibleQuestion:C,startQuestionChangeObserver:M}){v("[Study Assist] ALT+W pressed - reloading quick mode");let t=document.getElementById("study-assist-quick");t?(v("[Study Assist] Applying reloading animation to SA button"),t.classList.add("reloading"),setTimeout(()=>{t.classList.remove("reloading")},500),mt(),v("[Study Assist] Quick mode reloaded, question re-detected")):o.settings.quickMode&&D()?(L({handleQuickClick:s=>_(s)}),v("[Study Assist] Quick button created")):o.settings.quickMode?W(s=>{s?(L({handleQuickClick:n=>_(n)}),v("[Study Assist] Quick button created after waiting")):v("[Study Assist] No quiz content found in this frame")}):v("[Study Assist] Quick mode is disabled in settings")}function He(e={detectVisibleQuestion:C,startQuestionChangeObserver:M}){v("[Study Assist] SHIFT pressed - triggering quick analysis");let t=document.getElementById("study-assist-quick");if(t){if(t.classList.contains("loading")){v("[Study Assist] Already loading, ignoring");return}_()}else v("[Study Assist] Quick button not found, trying to create first"),o.settings.quickMode&&D()&&(L({handleQuickClick:s=>_(s)}),setTimeout(()=>{document.getElementById("study-assist-quick")&&_()},100))}function M(){o.questionChangeObserver&&(o.questionChangeObserver.disconnect(),o.questionChangeObserver=null),o.questionChangeInterval&&(clearInterval(o.questionChangeInterval),o.questionChangeInterval=null),o.questionChangeInterval=setInterval(()=>{if(o.lastAnsweredQuestionNum===null){o.questionChangeInterval&&(clearInterval(o.questionChangeInterval),o.questionChangeInterval=null);return}try{let e=re();if(!1,e!==null&&e!==o.lastAnsweredQuestionNum){if(!o.pendingQuestionChange||o.pendingQuestionChange!==e){o.pendingQuestionChange=e,v(`[Observer] Question change detected: ${o.lastAnsweredQuestionNum} \u2192 ${e}, waiting for confirmation...`);return}v("[Study Assist] Question changed from",o.lastAnsweredQuestionNum,"to",e),o.pendingQuestionChange=null,G(),o.questionChangeInterval&&(clearInterval(o.questionChangeInterval),o.questionChangeInterval=null)}else e===o.lastAnsweredQuestionNum&&(o.pendingQuestionChange=null)}catch{}},1e3)}async function mt(){let e=document.getElementById("study-assist-quick"),t=document.getElementById("study-assist-quick-container");e&&(e.classList.add("reloading"),o.hasValidAnswer=!1,e.innerHTML="<span>SA</span>",e.classList.remove("has-answer","multi-answer","multi-answer-large","matching-answer"),t&&t.classList.remove("matching-mode"),C().then(s=>{setTimeout(()=>{e.classList.remove("reloading")},500)}))}var ue=48;async function Re(e){let t=[];if(v("[Study Assist] sendImages setting:",o.settings.sendImages),o.settings.sendImages){if(e.platform==="moodle"){if(e.images&&e.images.length>0&&(t=[...e.images],v("[Study Assist] Moodle images found:",t.length)),e.options)for(let s of e.options)s.image&&t.push({...s.image,location:`option_${s.letter}`})}else if(e.element)try{v("[Study Assist] Extracting images from NetAcad element:",e.element.tagName),t=await se(e.element),v("[Study Assist] NetAcad images extracted:",t.length)}catch(s){console.error("[Study Assist] Image extraction error:",s)}}else v("[Study Assist] sendImages is OFF - no images will be sent");return v("[Study Assist] Total images to send:",t.length),t}function Ne(e,t,s){return e.type==="matching"?{questionText:e.text,questionType:"matching",matchingStyle:e.matchingStyle||"drag-drop",categories:e.categories,matchingOptions:e.matchingOptions,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:s,courseName:e.courseName,qaMode:Q()}:e.type==="select-missing-words"?{questionText:e.text,questionType:"select-missing-words",selectGaps:e.selectGaps,selectChoices:e.selectChoices,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:s,courseName:e.courseName,qaMode:Q()}:e.type==="short-answer"||e.type==="numerical"?{questionText:e.text,questionType:e.type,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:s,courseName:e.courseName,qaMode:Q()}:{questionText:e.text,questionType:e.type==="true-false"?"true-false":"multiple-choice",options:e.options,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:s,courseName:e.courseName,qaMode:Q()}}function Pe(e){return new Promise((t,s)=>{let n=chrome.runtime.connect({name:"quick-analysis"});z.add(n);let i=!1,a=(f,p)=>{i||(i=!0,clearTimeout(r),z.delete(n),N.delete(n),n.onMessage.removeListener(l),n.onDisconnect.removeListener(c),n.disconnect(),p?s(p):t(f))},r=setTimeout(()=>a(void 0,new Error("Analysis timeout")),36e4);N.set(n,()=>a(void 0,new Error("Analysis cancelled")));let c=()=>a(void 0,new Error("Analysis connection lost or cancelled")),l=f=>{i||(f.type==="STATUS"&&f.status?ht(f.status):f.type==="RESULT"&&f.result&&a(f.result))};n.onMessage.addListener(l),n.onDisconnect.addListener(c);try{n.postMessage({type:"ANALYZE_QUESTION",context:e})}catch(f){a(void 0,f)}})}function pt(e,t){let s=t.trim();if(e.type==="matching"||e.type==="select-missing-words")return s.toUpperCase().trim().slice(0,ue);if(e.type==="short-answer"||e.type==="numerical"){let c=s||"?";return c.length>ue?c.slice(0,ue-1)+"\u2026":c}let n=s.toUpperCase();if(e.type==="true-false")return Ie(s,e.options||[]);let i=n.match(/^([A-Z])\s*,\s*([A-Z])(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?$/),a=i?null:n.match(/^([A-Z])\s*\/\s*([A-Z])(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?$/);if(i||a){let c=i||a;return[c[1],c[2],c[3],c[4],c[5]].filter(Boolean).join(",")}let r=n.match(/\b([A-Z])\b/);return r?r[1]:"?"}async function ft(e,t={detectVisibleQuestion:C,startQuestionChangeObserver:M}){let s=A,n=document.getElementById("study-assist-quick");if(!n)return;let i=document.getElementById("study-assist-quick-container"),a=o.skipPrimary;o.skipPrimary=!1;let r=[],c=!1;for(let f=0;f<e.length;f++){let p=e[f];if(o.requestCancelled||s!==A){v("[Study Assist] Multi request cancelled, stopping batch");break}v("[Study Assist] Multi analyzing question:",{index:f+1,total:e.length,questionNumber:p.questionNumber,questionType:p.type});try{let g=await Re(p);if(s!==A)return;let u=Ne(p,g,a),d=await Pe(u);if(o.requestCancelled||s!==A){v("[Study Assist] Multi request cancelled, ignoring response");break}let m=p.questionNumber??f+1;d.success&&d.result?(c=!0,r.push(`${m}:${pt(p,d.result)}`)):r.push(`${m}:?`)}catch(g){console.error("[Study Assist] Multi analysis error:",g);let u=p.questionNumber??f+1;r.push(`${u}:?`)}}if(o.slowConnectionTimer&&(clearTimeout(o.slowConnectionTimer),o.slowConnectionTimer=null),o.requestCancelled||s!==A){v("[Study Assist] Multi request was cancelled, ignoring response");return}if(n.classList.remove("loading","slow-connection"),o.isRequestInProgress=!1,!c||r.length===0){n.innerHTML="<span>!</span>",setTimeout(()=>{n.innerHTML="<span>SA</span>"},2e3);return}n.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(r.join(`
`))}</span>`,n.classList.add("has-answer","matching-answer"),i&&i.classList.add("matching-mode"),o.lastAnsweredQuestionNum=e[0].questionNumber??null,(t.startQuestionChangeObserver??M)(),o.hasValidAnswer=!0}async function _(e,t={detectVisibleQuestion:C,detectVisibleQuestions:le,startQuestionChangeObserver:M}){let s=document.getElementById("study-assist-quick");if(!s)return;if(o.hasValidAnswer){v("[Study Assist] Valid answer already displayed, use ALT+W to re-detect and request again");return}if(o.isRequestInProgress){v("[Study Assist] Request already in progress, ignoring");return}if(s.classList.contains("loading")){v("[Study Assist] Already loading (button state), ignoring");return}o.isRequestInProgress=!0;let n=++A;o.requestCancelled=!1,o.questionChangeInterval&&(clearInterval(o.questionChangeInterval),o.questionChangeInterval=null),o.lastAnsweredQuestionNum=null,o.slowConnectionTimer&&(clearTimeout(o.slowConnectionTimer),o.slowConnectionTimer=null);let i=document.getElementById("study-assist-quick-container");i&&i.classList.remove("matching-mode"),s.classList.remove("has-answer","multi-answer","multi-answer-large","matching-answer","slow-connection"),s.innerHTML='<span class="study-assist-quick-loading"></span>',s.classList.add("loading"),o.slowConnectionTimer=setTimeout(()=>{o.isRequestInProgress&&s.classList.contains("loading")&&(s.classList.add("slow-connection"),s.innerHTML='<span class="study-assist-slow-indicator">\u23F3</span>')},2e4);try{let r=await(t.detectVisibleQuestion??C)();if(n!==A)return;if(!r){s.innerHTML="<span>?</span>",s.classList.remove("loading"),o.isRequestInProgress=!1,setTimeout(()=>{s.innerHTML="<span>SA</span>"},1500);return}let l=await(t.detectVisibleQuestions??le)();if(n!==A)return;if(l.length>1){v("[Study Assist] Multi-question page detected:",l.length),await ft(l,t);return}let f=await Re(r);if(n!==A)return;let p=Ne(r,f,o.skipPrimary);o.skipPrimary=!1,v("[Study Assist] Sending to API:",{questionNumber:r.questionNumber,questionType:r.type,questionText:r.text?r.text.substring(0,80):"(no text)",optionsCount:r.options?r.options.length:0,options:r.options?r.options.map(u=>`${u.letter}: ${u.text?u.text.substring(0,30):""}`):[]});let g=await Pe(p);if(o.slowConnectionTimer&&(clearTimeout(o.slowConnectionTimer),o.slowConnectionTimer=null),o.requestCancelled||n!==A){v("[Study Assist] Request was cancelled, ignoring response");return}if(s.classList.remove("loading","slow-connection"),o.isRequestInProgress=!1,g.success&&g.result){let u=g.result.trim(),d=document.getElementById("study-assist-quick-container");if(o.lastAnsweredQuestionNum=r.questionNumber||null,(t.startQuestionChangeObserver??M)(),r.type==="matching"){let h=u.toUpperCase().trim().replace(/,\s*/g,`
`);s.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(h)}</span>`,s.classList.add("has-answer","matching-answer"),d&&d.classList.add("matching-mode"),o.hasValidAnswer=!0}else if(r.type==="select-missing-words"){let h=u.trim().replace(/,\s*/g,`
`);s.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(h)}</span>`,s.classList.add("has-answer","matching-answer"),d&&d.classList.add("matching-mode"),o.hasValidAnswer=!0}else if(r.type==="short-answer"||r.type==="numerical"){let h=u.trim()||"?";s.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(h)}</span>`,s.classList.add("has-answer","matching-answer"),d&&d.classList.add("matching-mode"),h!=="?"&&(o.hasValidAnswer=!0)}else{let h=u.toUpperCase();if(r.type==="true-false"){let w=Ie(u,r.options||[]);s.innerHTML=`<span class="study-assist-quick-answer">${w}</span>`,s.classList.add("has-answer"),w!=="?"&&(o.hasValidAnswer=!0);return}let b=h.match(/^([A-Z])\s*,\s*([A-Z])(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?$/),y=b?null:h.match(/^([A-Z])\s*\/\s*([A-Z])(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?$/),x,q=!1,E=!1;if(b||y){let w=r.element,k=w instanceof HTMLElement&&w.querySelectorAll('input[type="radio"]').length>0,Ve=w instanceof HTMLElement&&w.querySelectorAll('input[type="checkbox"]').length>0;k&&!Ve&&(E=!0)}if(b||y){let w=b||y,k=[w[1],w[2],w[3],w[4],w[5]].filter(Boolean);E?x=k.join(" / "):x=k.join(","),q=!0}else{let w=h.match(/\b([A-Z])\b/);x=w?w[1]:"?"}s.innerHTML=`<span class="study-assist-quick-answer">${x}</span>`,s.classList.add("has-answer"),q&&(E?s.classList.add("multi-answer"):(s.classList.add("multi-answer"),x.split(",").length>=3&&s.classList.add("multi-answer-large"))),x!=="?"&&(o.hasValidAnswer=!0)}}else s.innerHTML="<span>!</span>",s.classList.remove("slow-connection"),o.isRequestInProgress=!1,setTimeout(()=>{s.innerHTML="<span>SA</span>"},2e3)}catch(a){if(n!==A)return;console.error("[Study Assist] Quick analysis error:",a),o.slowConnectionTimer&&(clearTimeout(o.slowConnectionTimer),o.slowConnectionTimer=null),s.classList.remove("loading","slow-connection"),s.innerHTML="<span>!</span>",o.isRequestInProgress=!1,setTimeout(()=>{n===A&&(s.innerHTML="<span>SA</span>")},2e3)}finally{n===A&&!o.isRequestInProgress&&o.slowConnectionTimer&&(clearTimeout(o.slowConnectionTimer),o.slowConnectionTimer=null)}}function me(e,t,s="log"){try{let n=chrome.runtime.sendMessage({type:"DEV_LOG",level:s,message:e,data:t});n&&typeof n.catch=="function"&&n.catch(()=>{})}catch{}}async function Be(e,t={detectVisibleQuestion:C,startQuestionChangeObserver:M}){if(!o.isActive||!o.isDomainAllowed||o.isRequestInProgress)return;o.isRequestInProgress=!0;let s=++A;Le();try{let n=[];if(o.settings.sendImages){if(e.platform==="moodle"){if(e.images&&e.images.length>0&&(n=[...e.images]),e.options)for(let p of e.options)p.image&&n.push({...p.image,location:`option_${p.letter}`})}else if(e.element)try{n=await se(e.element)}catch{}}let i;if(e.type==="matching"?i={questionText:e.text,questionType:"matching",matchingStyle:e.matchingStyle||"drag-drop",categories:e.categories,matchingOptions:e.matchingOptions,images:n,pageTitle:document.title,pageUrl:window.location.href,responseMode:o.settings.responseMode,courseName:e.courseName,qaMode:Q()}:e.type==="select-missing-words"?i={questionText:e.text,questionType:"select-missing-words",selectGaps:e.selectGaps,selectChoices:e.selectChoices,images:n,pageTitle:document.title,pageUrl:window.location.href,responseMode:o.settings.responseMode,courseName:e.courseName,qaMode:Q()}:e.type==="short-answer"||e.type==="numerical"?i={questionText:e.text,questionType:e.type,images:n,pageTitle:document.title,pageUrl:window.location.href,responseMode:o.settings.responseMode,courseName:e.courseName,qaMode:Q()}:i={questionText:e.text,questionType:e.type==="true-false"?"true-false":"multiple-choice",options:e.options,images:n,pageTitle:document.title,pageUrl:window.location.href,responseMode:o.settings.responseMode,courseName:e.courseName,qaMode:Q()},s!==A)return;let a=chrome.runtime.connect({name:"stream-analysis"});z.add(a),X("",e,t.showQuestionsSummary,!0);let r="",c=0,l=0,f=0;await new Promise((p,g)=>{let u=!1,d=y=>{u||(u=!0,clearTimeout(m),z.delete(a),N.delete(a),a.onMessage.removeListener(h),a.onDisconnect.removeListener(b),a.disconnect(),y?g(y):p())},m=setTimeout(()=>d(new Error("Stream timeout")),36e4);N.set(a,()=>d(new Error("Analysis cancelled")));let h=y=>{if(!(u||s!==A))switch(y.type){case"STREAM_CHUNK":r+=y.chunk,X(r,e,t.showQuestionsSummary,!1);break;case"STREAM_STATUS":y.status==="input_tokens"&&(c=y.inputTokens),y.status==="complete"&&(l=y.outputTokens);break;case"STREAM_COMPLETE":c=y.inputTokens||c,l=y.outputTokens||l,f=y.cost||0,$(),X(r,e,t.showQuestionsSummary,!1,{inputTokens:c,outputTokens:l,cost:f}),me("stream complete",{questionType:e.type,inputTokens:c,outputTokens:l,cost:f}),d();break;case"STREAM_ERROR":$(),me("stream error",{error:y.error,questionType:e.type},"error"),de(y.error||"Error de transmisi\xF3n",t.showQuestionsSummary),d(new Error(y.error));break}},b=()=>{u||d(new Error("Conexi\xF3n perdida: respuesta incompleta"))};a.onMessage.addListener(h),a.onDisconnect.addListener(b);try{a.postMessage({context:i})}catch(y){d(y)}})}catch(n){if(s!==A)return;$(),me("full analysis failed",{error:n.message},"error"),de(n.message,t.showQuestionsSummary)}finally{s===A&&(o.isRequestInProgress=!1)}}var gt={PRIMARY_RETRY:"\u26A0\uFE0F",VALIDATOR_FALLBACK:"\u{1F504}",VALIDATOR_VALIDATING:"\u{1F50D}"};function ht(e){let t=document.getElementById("study-assist-quick");if(!t)return;let s=gt[e];s&&(t.innerHTML=`<span>${s}</span>`)}async function Oe(){try{let{settings:e}=await chrome.runtime.sendMessage({type:"GET_CONTENT_SETTINGS"}),t=e.allowedDomains??ye,s=window.location.hostname.toLowerCase(),n=t.some(i=>s===i||s.endsWith("."+i));return o.isDomainAllowed=n,n}catch(e){return console.error("[Study Assist] Error checking domain:",e),!1}}function yt(){if(o.contentObserver)return;let e=null;o.contentObserver=new MutationObserver(t=>{e&&clearTimeout(e),e=setTimeout(()=>{o.isActive&&o.isDomainAllowed&&o.settings.quickMode&&!document.getElementById("study-assist-quick-container")&&D()&&vt()},500)}),o.contentObserver.observe(document.body??document.documentElement,{childList:!0,subtree:!0})}function vt(){L({handleQuickClick:e=>_(e,{detectVisibleQuestion:C,startQuestionChangeObserver:M})})}function Y(e){return Be(e,{detectVisibleQuestion:C,startQuestionChangeObserver:M,showQuestionsSummary:P})}function P(){return ke(C,Y)}function fe(){Ce({frameHasQuizContent:D,waitForQuizContent:W,handleQuickClick:e=>_(e,{detectVisibleQuestion:C,startQuestionChangeObserver:M}),showQuestionsSummary:P})}function ge(){_e({triggerQuickAnalysis:()=>He({detectVisibleQuestion:C,startQuestionChangeObserver:M}),reloadQuickMode:()=>De({detectVisibleQuestion:C,startQuestionChangeObserver:M}),toggleSAButtonVisibility:Me,cancelCurrentRequest:pe})}async function he(){if(!o.isActive||!o.isDomainAllowed)return;let e=await ae();e&&e.found&&(o.settings.highlightQuestions&&Z(Y),o.settings.quickMode||await P())}async function $e(){try{let e=await Oe(),{settings:t}=await chrome.runtime.sendMessage({type:"GET_CONTENT_SETTINGS"});if(o.settings.responseMode=t.responseMode??"direct",o.settings.autoDetect=t.autoDetect??!0,o.settings.highlightQuestions=t.highlightQuestions??!0,o.settings.quickMode=t.quickMode??!0,o.settings.sendImages=t.sendImages??!1,o.settings.buttonPosition=t.buttonPosition??"bottom-right",o.saButtonHidden=t.saButtonHidden===!0,!e)return;o.isActive=!0,o.isInitialized=!0;try{o.settings.quickMode&&ge()}catch(s){console.error("[Study Assist] Keyboard init error:",s)}try{fe()}catch(s){console.error("[Study Assist] Overlay init error:",s)}o.isActive&&o.settings.autoDetect&&setTimeout(()=>he(),1e3);try{yt()}catch(s){console.error("[Study Assist] Observer init error:",s)}}catch(e){console.error("[Study Assist] Initialization error:",e)}}function bt(){let e=document.getElementById("study-assist-qa-sandbox");e&&e.remove()}function xt(e){e.innerHTML=`
    <div class="qa-block">
      <h3>NetAcad Simulado \u2014 Opci\xF3n m\xFAltiple</h3>
      <p class="qa-tip">Usa <strong>SHIFT</strong> para quick mode, o clic en badge para an\xE1lisis completo.</p>
      <div class="qa-question-title">Pregunta 1</div>
      <mcq-view id="qa-netacad-mcq"></mcq-view>
    </div>
  `;let t=e.querySelector("#qa-netacad-mcq");if(!t)return;let s=t.attachShadow({mode:"open"});s.innerHTML=`
    <style>
      .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
      .mcq__item { margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
      .mcq__item-text-inner { font-size: 14px; color: #111827; }
    </style>
    <div class="mcq__body-inner">\xBFCu\xE1l capa del modelo OSI se encarga del enrutamiento?</div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa F\xEDsica</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Aplicaci\xF3n</div></div>
  `}function wt(e){e.innerHTML=`
    <div class="qa-block">
      <h3>NetAcad Simulado \u2014 Matching</h3>
      <p class="qa-tip">En quick mode la respuesta se mostrar\xE1 como pares (ej. <strong>A-2</strong>).</p>
      <div class="qa-question-title">Pregunta 1</div>
      <object-matching-view id="qa-netacad-matching"></object-matching-view>
    </div>
  `;let t=e.querySelector("#qa-netacad-matching");if(!t)return;let s=t.attachShadow({mode:"open"});s.innerHTML=`
    <style>
      .component__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
      .objectMatching-category-item,
      .objectMatching-option-item {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 6px 0;
        padding: 8px;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: #fff;
      }
      .category-item-number { font-weight: 700; min-width: 20px; }
      .category-item-text { color: #111827; }
    </style>
    <div class="component__body-inner">Relaciona cada protocolo con su puerto por defecto.</div>
    <div class="objectMatching-category-item"><span class="category-item-number">A</span><span class="category-item-text">HTTP</span></div>
    <div class="objectMatching-category-item"><span class="category-item-number">B</span><span class="category-item-text">HTTPS</span></div>
    <div class="objectMatching-category-item"><span class="category-item-number">C</span><span class="category-item-text">SSH</span></div>
    <hr />
    <div class="objectMatching-option-item"><span class="category-item-text">443</span></div>
    <div class="objectMatching-option-item"><span class="category-item-text">22</span></div>
    <div class="objectMatching-option-item"><span class="category-item-text">80</span></div>
  `}function qt(e){e.innerHTML=`
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Respuesta corta (Short Answer)</h3>
      <p class="qa-tip">La IA responder\xE1 con texto libre. Respuesta esperada: <strong>HyperText Transfer Protocol</strong>.</p>
      <div class="que shortanswer">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">\xBFQu\xE9 significa el acr\xF3nimo <strong>HTTP</strong> en el contexto de la World Wide Web?</div>
            <div class="answer">
              <input type="text" class="form-control d-inline" size="30" placeholder="Escribe tu respuesta aqu\xED" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `}function Et(e){e.innerHTML=`
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Num\xE9rica (Numerical)</h3>
      <p class="qa-tip">La IA responder\xE1 con un n\xFAmero. Respuesta esperada: <strong>32</strong>.</p>
      <div class="que numerical">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">\xBFCu\xE1ntos bits tiene una direcci\xF3n IPv4?</div>
            <div class="answer">
              <input type="text" class="form-control d-inline" size="15" placeholder="Respuesta num\xE9rica" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `}function Tt(e){e.innerHTML=`
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Selecciona las palabras faltantes (Select Missing Words)</h3>
      <p class="qa-tip">Respuesta esperada: <strong>[[1]]=HTTP, [[2]]=80, [[3]]=HTTPS, [[4]]=443</strong>.</p>
      <div class="que gapselect">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">El protocolo
              <select name="resp_1">
                <option value="0">Elegir...</option>
                <option value="1">HTTP</option>
                <option value="2">FTP</option>
                <option value="3">SSH</option>
              </select>
              utiliza el puerto
              <select name="resp_2">
                <option value="0">Elegir...</option>
                <option value="1">80</option>
                <option value="2">21</option>
                <option value="3">22</option>
              </select>
              para comunicaci\xF3n no cifrada, mientras que
              <select name="resp_3">
                <option value="0">Elegir...</option>
                <option value="1">HTTP</option>
                <option value="2">HTTPS</option>
                <option value="3">FTP</option>
              </select>
              usa el puerto
              <select name="resp_4">
                <option value="0">Elegir...</option>
                <option value="1">80</option>
                <option value="2">443</option>
                <option value="3">8080</option>
              </select>
              para comunicaci\xF3n cifrada.
            </div>
          </div>
        </div>
      </div>
    </div>
  `}function At(e){e.innerHTML=`
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Relacionar (Match)</h3>
      <p class="qa-tip">Respuesta esperada: <strong>A-2, B-1, C-3</strong> (categor\xEDa-opci\xF3n).</p>
      <div class="que match">
        <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
        <div class="content">
          <div class="formulation clearfix">
            <div class="qtext">Relaciona cada capa del modelo OSI con su funci\xF3n principal.</div>
            <div class="ablock">
              <table class="answer">
                <tbody>
                  <tr class="r0">
                    <td class="text">Enrutamiento l\xF3gico de paquetes</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa F\xEDsica</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                  <tr class="r1">
                    <td class="text">Transmisi\xF3n de bits por el medio f\xEDsico</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa F\xEDsica</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                  <tr class="r0">
                    <td class="text">Control de flujo y segmentaci\xF3n extremo a extremo</td>
                    <td class="control">
                      <select>
                        <option value="0">Elegir...</option>
                        <option value="1">Capa F\xEDsica</option>
                        <option value="2">Capa de Red</option>
                        <option value="3">Capa de Transporte</option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `}function ze(e){let t=Array.from(e.querySelectorAll(".qa-slide"));if(t.length===0)return;let s=0,n=e.querySelector("#qa-nav-prev"),i=e.querySelector("#qa-nav-next"),a=e.querySelector(".qa-quiz-progress");function r(){t.forEach((c,l)=>{c.style.display=l===s?"":"none"}),n&&(n.disabled=s<=0),i&&(i.disabled=s>=t.length-1),a&&(a.textContent=`Pregunta ${s+1} de ${t.length}`),window.dispatchEvent(new CustomEvent("study-assist-navigate"))}n&&n.addEventListener("click",()=>{s>0&&(s--,r())}),i&&i.addEventListener("click",()=>{s<t.length-1&&(s++,r())})}function St(e){e.innerHTML=`
    <div class="qa-quiz-header">
      <span class="qa-quiz-platform">\u{1F535} NetAcad \u2014 Quiz Real</span>
      <div class="qa-quiz-nav">
        <button class="qa-sandbox-nav-btn" id="qa-nav-prev" disabled>\u2190 Anterior</button>
        <span class="qa-quiz-progress">Pregunta 1 de 2</span>
        <button class="qa-sandbox-nav-btn" id="qa-nav-next">Siguiente \u2192</button>
      </div>
    </div>
    <p class="qa-tip">La detecci\xF3n se actualiza autom\xE1ticamente al navegar.</p>

    <div class="qa-slide" data-slide="0">
      <div class="qa-block">
        <h3>Pregunta 1 \u2014 Opci\xF3n m\xFAltiple (MCQ)</h3>
        <div class="qa-question-title">Pregunta 1</div>
        <mcq-view id="qa-netacad-quiz-mcq"></mcq-view>
      </div>
    </div>

    <div class="qa-slide" data-slide="1" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 2 \u2014 Relacionar (Matching)</h3>
        <p class="qa-tip">En quick mode la respuesta se mostrar\xE1 como pares (ej. <strong>A-2</strong>).</p>
        <div class="qa-question-title">Pregunta 2</div>
        <object-matching-view id="qa-netacad-quiz-matching"></object-matching-view>
      </div>
    </div>
  `;let t=e.querySelector("#qa-netacad-quiz-mcq");if(t){let n=t.attachShadow({mode:"open"});n.innerHTML=`
      <style>
        .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
        .mcq__item { margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
        .mcq__item-text-inner { font-size: 14px; color: #111827; }
      </style>
      <div class="mcq__body-inner">\xBFCu\xE1l capa del modelo OSI se encarga del enrutamiento l\xF3gico de paquetes?</div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa F\xEDsica</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace de Datos</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Transporte</div></div>
    `}let s=e.querySelector("#qa-netacad-quiz-matching");if(s){let n=s.attachShadow({mode:"open"});n.innerHTML=`
      <style>
        .component__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
        .objectMatching-category-item,
        .objectMatching-option-item {
          display: flex; align-items: center; gap: 8px;
          margin: 6px 0; padding: 8px;
          border: 1px solid #e5e7eb; border-radius: 8px; background: #fff;
        }
        .category-item-number { font-weight: 700; min-width: 20px; }
      </style>
      <div class="component__body-inner">Relaciona cada protocolo con su puerto por defecto.</div>
      <div class="objectMatching-category-item"><span class="category-item-number">A</span><span class="category-item-text">HTTP</span></div>
      <div class="objectMatching-category-item"><span class="category-item-number">B</span><span class="category-item-text">HTTPS</span></div>
      <div class="objectMatching-category-item"><span class="category-item-number">C</span><span class="category-item-text">SSH</span></div>
      <hr />
      <div class="objectMatching-option-item"><span class="category-item-text">443</span></div>
      <div class="objectMatching-option-item"><span class="category-item-text">22</span></div>
      <div class="objectMatching-option-item"><span class="category-item-text">80</span></div>
    `}ze(e)}function Fe(e){e.innerHTML=`
    <div class="qa-block">
      <h3>Moodle Simulado \u2014 Varias preguntas visibles</h3>
      <p class="qa-tip">Las 3 preguntas est\xE1n visibles a la vez. Usa <strong>SHIFT</strong> para responderlas todas (ej. <strong>4:V, 5:B, 6:C</strong>).</p>
      <div class="que truefalse">
        <div class="info"><h3 class="no">Pregunta <span class="qno">4</span></h3></div>
        <div class="qtext">La seguridad activa se utiliza dia a dia para evitar cualquier tipo de ataque.</div>
        <div class="answer">
          <div class="r0">
            <input type="radio" name="qa_multi_4" value="1" id="qa_multi_4_true" />
            <label for="qa_multi_4_true" class="ms-1">Verdadero</label>
          </div>
          <div class="r1">
            <input type="radio" name="qa_multi_4" value="0" id="qa_multi_4_false" />
            <label for="qa_multi_4_false" class="ms-1">Falso</label>
          </div>
        </div>
      </div>
      <div class="que multichoice">
        <div class="info"><h3 class="no">Pregunta <span class="qno">5</span></h3></div>
        <div class="qtext">Consiste en asegurar que los recursos del sistema se utilicen como se decidio.</div>
        <div class="answer">
          <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">Base de datos</div></div>
          <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">Seguridad Informatica</div></div>
          <div class="r0"><span class="answernumber">c.</span><div class="flex-fill">Derecho Informatico</div></div>
          <div class="r1"><span class="answernumber">d.</span><div class="flex-fill">Auditoria Informatica</div></div>
        </div>
      </div>
      <div class="que multichoice">
        <div class="info"><h3 class="no">Pregunta <span class="qno">6</span></h3></div>
        <div class="qtext">Las acciones de esta fase deben darse regularmente para lograr resultados favorables.</div>
        <div class="answer">
          <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">Verificar</div></div>
          <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">Hacer</div></div>
          <div class="r0"><span class="answernumber">c.</span><div class="flex-fill">Actuar</div></div>
          <div class="r1"><span class="answernumber">d.</span><div class="flex-fill">Planificar</div></div>
        </div>
      </div>
    </div>
  `}function Ct(e){e.innerHTML=`
    <div class="qa-quiz-header">
      <span class="qa-quiz-platform">\u{1F7E3} Moodle \u2014 Quiz Real</span>
      <div class="qa-quiz-nav">
        <button class="qa-sandbox-nav-btn" id="qa-nav-prev" disabled>\u2190 Anterior</button>
        <span class="qa-quiz-progress">Pregunta 1 de 6</span>
        <button class="qa-sandbox-nav-btn" id="qa-nav-next">Siguiente \u2192</button>
      </div>
    </div>
    <p class="qa-tip">La detecci\xF3n se actualiza autom\xE1ticamente al navegar.</p>

    <div class="qa-slide" data-slide="0">
      <div class="qa-block">
        <h3>Pregunta 1 \u2014 Opci\xF3n m\xFAltiple (MCQ)</h3>
        <div class="que multichoice">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">\xBFQu\xE9 protocolo utiliza el puerto 443 por defecto?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">HTTP</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">HTTPS</div></div>
            <div class="r0"><span class="answernumber">c.</span><div class="flex-fill">FTP</div></div>
            <div class="r1"><span class="answernumber">d.</span><div class="flex-fill">Telnet</div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="1" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 2 \u2014 Verdadero/Falso</h3>
        <div class="que truefalse">
          <div class="info"><h3 class="no">Pregunta <span class="qno">2</span></h3></div>
          <div class="qtext">La entrop\xEDa representa la tendencia natural de un sistema a desorganizarse.</div>
          <div class="answer">
            <div class="r0">
              <input type="radio" name="qa_tf" value="1" id="qa_tf_true" />
              <label for="qa_tf_true" class="ms-1">Verdadero</label>
            </div>
            <div class="r1">
              <input type="radio" name="qa_tf" value="0" id="qa_tf_false" />
              <label for="qa_tf_false" class="ms-1">Falso</label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="2" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 3 \u2014 Relacionar (Match)</h3>
        <div class="que match">
          <div class="info"><h3 class="no">Pregunta <span class="qno">3</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">Relaciona cada capa del modelo OSI con su funci\xF3n principal.</div>
              <div class="ablock">
                <table class="answer">
                  <tbody>
                    <tr class="r0">
                      <td class="text">Enrutamiento l\xF3gico de paquetes</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa F\xEDsica</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                    <tr class="r1">
                      <td class="text">Transmisi\xF3n de bits por el medio f\xEDsico</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa F\xEDsica</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                    <tr class="r0">
                      <td class="text">Control de flujo y segmentaci\xF3n extremo a extremo</td>
                      <td class="control">
                        <select>
                          <option value="0">Elegir...</option>
                          <option value="1">Capa F\xEDsica</option>
                          <option value="2">Capa de Red</option>
                          <option value="3">Capa de Transporte</option>
                        </select>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="3" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 4 \u2014 Respuesta corta (Short Answer)</h3>
        <div class="que shortanswer">
          <div class="info"><h3 class="no">Pregunta <span class="qno">4</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">\xBFCu\xE1l es el nombre completo del protocolo cuyas siglas son HTTP?</div>
              <div class="ablock">
                <label for="qa_sa_input">Respuesta:</label>
                <input type="text" id="qa_sa_input" class="form-control d-inline" size="30" placeholder="Escribe tu respuesta..." />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="4" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 5 \u2014 Num\xE9rica (Numerical)</h3>
        <div class="que numerical">
          <div class="info"><h3 class="no">Pregunta <span class="qno">5</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">\xBFCu\xE1ntos bits componen una direcci\xF3n IPv4?</div>
              <div class="ablock">
                <label for="qa_num_input">Respuesta:</label>
                <input type="text" id="qa_num_input" class="form-control d-inline" size="10" placeholder="N\xFAmero..." />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-slide" data-slide="5" style="display:none">
      <div class="qa-block">
        <h3>Pregunta 6 \u2014 Seleccionar palabras que faltan (Gap Select)</h3>
        <div class="que gapselect">
          <div class="info"><h3 class="no">Pregunta <span class="qno">6</span></h3></div>
          <div class="content">
            <div class="formulation clearfix">
              <div class="qtext">El protocolo
                <select name="resp_1">
                  <option value="0">Elegir...</option>
                  <option value="1">HTTP</option>
                  <option value="2">FTP</option>
                  <option value="3">SMTP</option>
                </select>
                utiliza el puerto
                <select name="resp_2">
                  <option value="0">Elegir...</option>
                  <option value="1">80</option>
                  <option value="2">21</option>
                  <option value="3">25</option>
                </select>
                para tr\xE1fico no cifrado, mientras que
                <select name="resp_3">
                  <option value="0">Elegir...</option>
                  <option value="1">HTTPS</option>
                  <option value="2">SFTP</option>
                  <option value="3">SMTPS</option>
                </select>
                utiliza el puerto
                <select name="resp_4">
                  <option value="0">Elegir...</option>
                  <option value="1">443</option>
                  <option value="2">22</option>
                  <option value="3">465</option>
                </select>
                para comunicaciones seguras.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,ze(e)}function Mt(e){let t="study-assist-qa-sandbox-style",s=document.getElementById(t);s||(s=document.createElement("style"),s.id=t,document.head.appendChild(s)),s.textContent=`
      /* example.com style div { opacity: 0.8 }; neutralize it inside the sandbox. */
      #study-assist-qa-sandbox,
      #study-assist-qa-sandbox div { opacity: 1; }
      #study-assist-qa-sandbox {
        position: relative;
        z-index: 9997;
        margin: 20px;
        padding: 16px;
        border: 2px dashed #3b82f6;
        border-radius: 12px;
        background: #fff;
        font-family: Arial, sans-serif;
      }
      #study-assist-qa-sandbox h2 { margin: 0 0 8px; color: #1d4ed8; }
      #study-assist-qa-sandbox .qa-meta { margin: 0 0 12px; color: #334155; font-size: 13px; }
      #study-assist-qa-sandbox .qa-block { margin-top: 10px; }
      #study-assist-qa-sandbox .qa-question-title { font-weight: 700; margin: 10px 0; }
      #study-assist-qa-sandbox .qa-tip { color: #475569; font-size: 13px; margin-bottom: 8px; }
      #study-assist-qa-sandbox .que {
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 12px;
        background: white;
      }
      #study-assist-qa-sandbox .qtext { margin: 8px 0; color: #111827; }
      #study-assist-qa-sandbox .answer .r0,
      #study-assist-qa-sandbox .answer .r1 {
        margin: 6px 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #study-assist-qa-sandbox .qa-quiz-header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid #cbd5e1;
      }
      #study-assist-qa-sandbox .qa-quiz-platform {
        font-weight: 700;
        color: #1d4ed8;
        font-size: 15px;
        flex: 1;
      }
      #study-assist-qa-sandbox .qa-quiz-nav {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #study-assist-qa-sandbox .qa-quiz-progress {
        font-size: 13px;
        color: #334155;
        min-width: 80px;
        text-align: center;
      }
      #study-assist-qa-sandbox .qa-sandbox-nav-btn {
        padding: 4px 10px;
        font-size: 13px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
      }
      #study-assist-qa-sandbox .qa-sandbox-nav-btn:disabled {
        background: #94a3b8;
        cursor: default;
      }
      #study-assist-qa-sandbox table.answer {
        width: 100%;
        border-collapse: collapse;
      }
      #study-assist-qa-sandbox table.answer td {
        padding: 8px;
        border: 1px solid #e2e8f0;
        vertical-align: middle;
      }
      #study-assist-qa-sandbox table.answer td.control select {
        padding: 4px 6px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: white;
        font-size: 13px;
      }
    `;let n=document.createElement("section");n.id="study-assist-qa-sandbox",n.innerHTML=`
    <h2>\u{1F9EA} Study Assist QA Sandbox</h2>
    <p class="qa-meta">
      Escenario: <strong>${e}</strong> \xB7 Usa ALT+W para recargar detecci\xF3n y SHIFT para quick analysis.
    </p>
  `;let i=document.createElement("div");n.appendChild(i),e==="moodle-mcq"?i.innerHTML=`
      <div class="qa-block">
        <h3>Moodle Simulado \u2014 Opci\xF3n m\xFAltiple</h3>
        <div class="que multichoice">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">\xBFQu\xE9 protocolo utiliza el puerto 443 por defecto?</div>
          <div class="answer">
            <div class="r0"><span class="answernumber">a.</span><div class="flex-fill">HTTP</div></div>
            <div class="r1"><span class="answernumber">b.</span><div class="flex-fill">HTTPS</div></div>
            <div class="r0"><span class="answernumber">c.</span><div class="flex-fill">FTP</div></div>
            <div class="r1"><span class="answernumber">d.</span><div class="flex-fill">Telnet</div></div>
          </div>
        </div>
      </div>
    `:e==="moodle-truefalse"?i.innerHTML=`
      <div class="qa-block">
        <h3>Moodle Simulado \u2014 Verdadero/Falso</h3>
        <div class="que truefalse">
          <div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3></div>
          <div class="qtext">La entrop\xEDa representa la tendencia natural de un sistema a desorganizarse.</div>
          <div class="answer">
            <div class="r0">
              <input type="radio" name="qa_tf" value="1" id="qa_tf_true" />
              <label for="qa_tf_true" class="ms-1">Verdadero</label>
            </div>
            <div class="r1">
              <input type="radio" name="qa_tf" value="0" id="qa_tf_false" />
              <label for="qa_tf_false" class="ms-1">Falso</label>
            </div>
          </div>
        </div>
      </div>
    `:e==="moodle-shortanswer"?qt(i):e==="moodle-numerical"?Et(i):e==="moodle-gapselect"?Tt(i):e==="netacad-mcq"?xt(i):e==="moodle-match"?At(i):e==="netacad-quiz"?St(i):e==="moodle-quiz"?Ct(i):e==="moodle-multi"?Fe(i):wt(i),document.body.prepend(n)}async function kt(){let e=await ae();return e?.found&&Z(Y),e?.count??0}chrome.runtime.onMessage.addListener((e,t,s)=>{switch(e.type){case"DOMAIN_SETTINGS_CHANGED":return(async()=>(await Oe()?o.isActive||await $e():(o.isActive=!1,pe(),o.contentObserver?.disconnect(),o.contentObserver=null,o.questionChangeInterval&&clearInterval(o.questionChangeInterval),o.questionChangeInterval=null,R(),O(),document.getElementById("study-assist-quick-container")?.remove()),s({success:!0})))(),!0;case"SETTINGS_CHANGED":if(!o.isDomainAllowed){s({success:!1,error:"Domain not allowed"});break}let n=o.settings.quickMode;o.settings={...o.settings,...e.settings},n!==o.settings.quickMode&&(o.settings.quickMode&&ge(),fe()),o.settings.highlightQuestions&&o.isActive?Z(Y):R(),s({success:!0});break;case"ANALYZE_PAGE":if(!o.isDomainAllowed){s({success:!1,error:"Domain not allowed"});break}o.isActive&&(async()=>(await he(),await P()))(),s({success:!0});break;case"CLEAR_RESULTS":R(),O(),o.detectedQuestions=[],s({success:!0});break;case"FORCE_STATE_RESET":o.isRequestInProgress=!1,o.hasValidAnswer=!1,o.skipPrimary=!1,o.requestCancelled=!1,o.pendingQuestionChange=null,o.slowConnectionTimer&&(clearTimeout(o.slowConnectionTimer),o.slowConnectionTimer=null),v("[Study Assist] Force state reset complete"),s({success:!0});break;case"ANALYSIS_RESULT":e.result&&e.question&&Qe(e.result,e.question,P),s({success:!0});break;case"QA_INJECT_SCENARIO":return(async()=>{try{let i=e.scenario??"moodle-truefalse",a=e.fullMode===!0;Mt(i),o.isDomainAllowed=!0,o.isActive=!0,o.settings.quickMode=!a,o.settings.highlightQuestions=!0,ge(),fe();let r=await kt();a&&await P(),v("[Study Assist] QA preview detected questions:",r),s({success:!0})}catch(i){s({success:!1,error:i.message})}})(),!0;case"QA_CLEAR_SCENARIO":bt(),R(),O(),G(),o.detectedQuestions=[],s({success:!0});break}return!0});window.addEventListener("study-assist-navigate",()=>{o.isActive&&o.isDomainAllowed&&he()});$e();var ds={injectMoodleMulti:Fe};})();
