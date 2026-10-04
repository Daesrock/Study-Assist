"use strict";(()=>{var H=!1,v=(...e)=>{H&&console.log(...e)},a={isActive:!1,isDomainAllowed:!1,isInitialized:!1,settings:{responseMode:"direct",autoDetect:!0,highlightQuestions:!0,quickMode:!0,sendImages:!1,buttonPosition:"bottom-right"},detectedQuestions:[],currentVisibleQuestion:null,overlayVisible:!1,contentObserver:null,lastAnsweredQuestionNum:null,questionChangeObserver:null,questionChangeInterval:null,isRequestInProgress:!1,hasValidAnswer:!1,skipPrimary:!1,slowConnectionTimer:null,requestCancelled:!1,pendingQuestionChange:null,saButtonHidden:!1},be=[];function T(e,t=document){let n=[];function s(i){if(i.shadowRoot){try{let r=i.shadowRoot.querySelectorAll(e);n.push(...Array.from(r))}catch{}let o=i.shadowRoot.querySelectorAll("*");for(let r of o)s(r)}}try{let i=t.querySelectorAll(e);n.push(...Array.from(i))}catch{}"shadowRoot"in t&&t.shadowRoot&&s(t);try{let i=t.querySelectorAll("*");for(let o of i)s(o)}catch{}return n}function xe(e=document){let t=[];function n(i){if(i.shadowRoot){t.push({element:i.tagName,shadowRoot:i.shadowRoot});let o=i.shadowRoot.querySelectorAll("*");for(let r of o)n(r)}}let s=e.querySelectorAll("*");for(let i of s)n(i);return t}function te(e){let t="";function n(s){if(s.nodeType===Node.TEXT_NODE)t+=s.textContent+" ";else if(s.nodeType===Node.ELEMENT_NODE){let i=s;if(i.shadowRoot)for(let o of i.shadowRoot.childNodes)n(o);for(let o of s.childNodes)n(o)}}return n(e),t.replace(/\s+/g," ").trim()}function we(e){let t="";for(let n of e.childNodes)n.nodeType===Node.TEXT_NODE&&(t+=n.textContent);return t}function j(e){let t=window.getComputedStyle(e);if(t.display==="none"||t.visibility==="hidden"||t.opacity==="0")return"";let n="",s=document.createTreeWalker(e,NodeFilter.SHOW_TEXT,{acceptNode:o=>{let r=o.parentElement;if(!r)return NodeFilter.FILTER_REJECT;let d=window.getComputedStyle(r);return d.display==="none"||d.visibility==="hidden"?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}}),i;for(;i=s.nextNode();)n+=i.textContent+" ";return n.replace(/\s+/g," ").trim()}function N(e){let t=[],n=new Set;function s(l){let f=l?.trim();f&&f.length>20&&!n.has(f)&&(n.add(f),t.push(f))}function i(l){if(!l)return;l instanceof Element&&l.classList?.contains("a11y_description")&&s(l.textContent);let f=l.querySelectorAll?.(".a11y_description");if(f)for(let m of f)s(m.textContent);if(l instanceof Element&&l.shadowRoot){let m=l.shadowRoot.querySelectorAll(".a11y_description");for(let u of m)s(u.textContent);let g=l.shadowRoot.querySelectorAll("*");for(let u of g)i(u)}}i(e);let o=T("[role='figure']",e);for(let l of o){let f=l.getAttribute("aria-labelledby");if(f){let m=T(`#${f}`,e)[0];m&&s(m.textContent)}}let r=T("dynamic-graphic-view",e);for(let l of r)i(l);let d=T("tabs-view",e);for(let l of d)i(l);return t.length>0&&v("[Study Assist] Found accessibility descriptions:",t.length),t.join(`

`)}function qe(e){let t=e.getBoundingClientRect(),n=window.innerHeight,s=window.innerWidth;if(t.bottom<0||t.top>n||t.right<0||t.left>s)return 0;let i=Math.max(0,t.top),o=Math.min(n,t.bottom),r=Math.max(0,t.left),d=Math.min(s,t.right),l=o-i,f=d-r,m=l*f,g=t.width*t.height;if(g===0)return 0;let u=(t.top+t.bottom)/2,c=n/2,p=1-Math.abs(u-c)/n;return m/g*.7+p*.3}function Ee(e,t){for(let n of t)if(n.element.contains(e)&&n.element!==e)return!0;return!1}function ne(e,t){return e.length<=t?e:e.substring(0,t).trim()+"..."}function S(e){let t=document.createElement("div");return t.textContent=e,t.innerHTML}function se(e){let t=S(e);return t=t.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>"),t=t.replace(/__(.+?)__/g,"<strong>$1</strong>"),t=t.replace(/\*(.+?)\*/g,"<em>$1</em>"),t=t.replace(/_(.+?)_/g,"<em>$1</em>"),t=t.replace(/\n\n/g,"</p><p>"),t=t.replace(/\n/g,"<br>"),t=`<p>${t}</p>`,t}function I(e){try{let t=new URL(e);if(t.protocol!=="https:"||t.username||t.password||t.search||t.hash)return!1;let n=t.hostname.toLowerCase();return!n.includes(".")||n.includes(":")||/^\d+(\.\d+){3}$/.test(n)||/(^|\.)(localhost|local|internal|home|lan)$/.test(n)?!1:!t.pathname.includes("/pluginfile.php/")}catch{return!1}}async function ie(e){let t=[],n=T("img",e);for(let s of n)try{let i=s.src;if(i.startsWith("data:")&&i.length<500||i.includes("icon")||i.includes("logo")||i.includes("avatar"))continue;s.complete||await new Promise(d=>{s.onload=()=>d(),s.onerror=()=>d(),setTimeout(d,3e3)});let o=s.naturalWidth||s.width||100,r=s.naturalHeight||s.height||100;if(o<30||r<30)continue;if(I(i))t.push({url:i,mediaType:"image/jpeg"});else{let d=await $(s);d&&t.push(d)}}catch(i){console.warn("[Study Assist] Failed to extract image:",i)}return t}async function $(e){return new Promise(t=>{try{if(!e.complete){e.onload=()=>Te(e,t),e.onerror=()=>t(null);return}Te(e,t)}catch(n){console.warn("[Study Assist] Image conversion error:",n),t(null)}})}function Te(e,t){try{let n=document.createElement("canvas");if(n.width=e.naturalWidth||e.width,n.height=e.naturalHeight||e.height,n.width<50||n.height<50){t(null);return}let s=n.getContext("2d");if(!s){t(null);return}s.drawImage(e,0,0);let o=n.toDataURL("image/png").replace(/^data:image\/\w+;base64,/,"");t({base64:o,mediaType:"image/png"})}catch{Ke(e.src).then(t).catch(()=>t(null))}}async function Ke(e){try{let n=await(await fetch(e)).blob();return new Promise((s,i)=>{let o=new FileReader;o.onloadend=()=>{let d=o.result.replace(/^data:image\/\w+;base64,/,""),l=n.type||"image/png";s({base64:d,mediaType:l})},o.onerror=i,o.readAsDataURL(n)})}catch(t){return console.warn("[Study Assist] Failed to fetch image:",t),null}}var W={questionMarkers:/\?|what|which|how|why|when|where|who|whose|whom|explain|describe|define|identify|select|choose|pick|determine|calculate|compute|find|solve|analyze|evaluate|compare|contrast|list|name|state|qué|cuál|cómo|por\s*qué|cuándo|dónde|quién|pregunta\s*\d+/i,multipleChoice:[/^\s*[A-Da-d][\.\)\:]?\s+.+/m,/^\s*\([A-Da-d]\)\s+.+/m,/^\s*[1-4][\.\)\:]?\s+.+/m,/\b(?:option|choice|answer)\s*[A-Da-d1-4]/i,/<input[^>]*type=["']?radio["']?[^>]*>/i,/\bselect\s+(?:one|all|the\s+(?:correct|best|right))/i,/radio_button_(?:checked|unchecked)/i,/pregunta\s*\d+/i],trueFalse:[/\b(?:true|false)\b.*\b(?:true|false)\b/i,/^\s*(?:True|False|T|F)[\.\)\s]/m,/\b(?:is\s+this|this\s+is)\s+(?:true|false|correct|incorrect)\b/i,/\b(?:verdadero|falso)\b/i],fillBlank:[/_{2,}|\.{3,}|\[?\s*blank\s*\]?/i,/fill\s+(?:in\s+)?(?:the\s+)?(?:blank|gap)/i,/complete\s+(?:la|el|los|las)/i]};function oe(e){if(!e||e.length<100)return e;let t=[/(?:consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n|figura|tabla|gr[aá]fic[ao]))[.:,]?\s*/i,/(?:refer\s+to\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i,/(?:see\s+the\s+(?:exhibit|figure|diagram|image|table|graphic))[.:,]?\s*/i];for(let o of t){let r=e.match(o);if(r&&r.index!==void 0){let d=e.substring(r.index).trim();if(d.includes("?"))return v(`[Study Assist] Cleaned question text: "${e.substring(0,50)}..." \u2192 "${d.substring(0,100)}..."`),d}}let n=e.split(`
`).map(o=>o.trim()).filter(o=>o.length>0),s=/^[A-Z]\s+[\d\.:/]+|^\w+\([^)]+\)\s*#|^[\d\.]+ \[|gateway\s+of\s+last\s+resort/i;if(n.filter(o=>s.test(o)).length>n.length*.3){let o=e.split(/[.!¿]\s+/).filter(r=>r.includes("?"));if(o.length>0){let r=o[o.length-1].trim(),d=e.match(/(consulte\s+(?:la\s+)?(?:imagen|ilustraci[oó]n|exhibici[oó]n)[.:,]?\s+[^¿?]+\?)/i);return d?(v(`[Study Assist] Cleaned question text (table detected): "${e.substring(0,50)}..." \u2192 "${d[1].trim().substring(0,100)}..."`),d[1].trim()):(v(`[Study Assist] Cleaned question text (table detected): "${e.substring(0,50)}..." \u2192 "${r.substring(0,100)}..."`),r)}}return e}async function le(e=0){if(a.isActive)return a.detectedQuestions=[],await Ye(),a.detectedQuestions.length===0&&Je(),a.detectedQuestions.length===0&&nt(),{found:a.detectedQuestions.length>0,count:a.detectedQuestions.length,retryCount:e}}async function Ye(){let e=document.querySelectorAll(".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect");if(e.length!==0)for(let[t,n]of Array.from(e).entries())if(n.classList.contains("match")){let s=await Se(n);s&&(s.id=`moodle-q-${t}`,a.detectedQuestions.push(s))}else if(n.classList.contains("shortanswer")){let s=await U(n,"short-answer");s&&(s.id=`moodle-q-${t}`,a.detectedQuestions.push(s))}else if(n.classList.contains("numerical")){let s=await U(n,"numerical");s&&(s.id=`moodle-q-${t}`,a.detectedQuestions.push(s))}else if(n.classList.contains("gapselect")){let s=await Me(n);s&&(s.id=`moodle-q-${t}`,a.detectedQuestions.push(s))}else{let s=await Ae(n);s&&a.detectedQuestions.push({id:`moodle-q-${t}`,element:n,text:s.text,type:s.type,options:s.options,questionNumber:s.questionNumber,images:s.images,confidence:95,platform:"moodle",courseName:s.courseName})}}function Je(){let e=xe(),t=T("mcq-view");if(t.length>0&&(t.forEach((m,g)=>{let u=m.shadowRoot;if(!u)return;let c="",p=T(".mcq__body-inner",u);if(p.length>0){let E=p[0].textContent?.trim()||"";c=oe(E)}if(!c){let E=T(".mcq__header, .component__body",u);if(E.length>0){let q=E[0].textContent?.trim()||"";c=oe(q)}}if(!c){c=te(m);let E=c.split(`
`).filter(q=>q.trim().length>10);E.length>0&&(c=E[0].trim())}let h=T(".mcq__item-text-inner",u),b=[];h.forEach((E,q)=>{let L=E.textContent?.trim()||"";L&&L.length>0&&b.push({letter:String.fromCharCode(65+q),text:L})});let y=g+1,w=te(m).match(/pregunta\s*(\d+)/i);w&&(y=parseInt(w[1])),b.length>=2&&a.detectedQuestions.push({id:`q-${g}`,questionNumber:y,element:m,text:c||`Question ${y}`,type:"multiple-choice",options:b,confidence:95})}),a.detectedQuestions.length>0))return;let n=T(".mcq__item-text-inner");if(n.length>0){let m=new Map;n.forEach(u=>{let c=u;for(;c&&c.tagName!=="MCQ-VIEW";)c=c.parentElement||c.host;c&&(m.has(c)||m.set(c,[]),m.get(c).push(u.textContent?.trim()||""))});let g=0;if(m.forEach((u,c)=>{let p=T(".mcq__body-inner",c.shadowRoot||c)[0],h=p?p.textContent?.trim()||`Question ${g+1}`:`Question ${g+1}`,b=oe(h),y=u.map((x,w)=>({letter:String.fromCharCode(65+w),text:x}));y.length>=2&&(a.detectedQuestions.push({id:`q-${g}`,element:c,text:b,type:"multiple-choice",options:y,confidence:90}),g++)}),a.detectedQuestions.length>0)return}let s=new Set;document.querySelectorAll("*").forEach(m=>{m.className&&typeof m.className=="string"&&m.className.split(/\s+/).forEach(g=>{g.length>0&&s.add(g)})});let i=Array.from(s).filter(m=>/mcq|question|answer|option|choice|radio|check|select|quiz|item/i.test(m)),o=document.querySelectorAll('input[type="radio"], input[type="checkbox"]');if(o.length>=2){let m=new Map;o.forEach(u=>{let c=u.name||u.id||"unnamed";m.has(c)||m.set(c,[]),m.get(c).push(u)});let g=0;if(m.forEach((u,c)=>{if(u.length>=2){let p=u[0].closest('form, fieldset, [role="group"], [role="radiogroup"]');if(!p){p=u[0].parentElement;for(let h=0;h<10&&!(!p||!p.parentElement||u.every(y=>p.contains(y))&&p.innerText&&p.innerText.length>50);h++)p=p.parentElement}if(p){let h=u.map((x,w)=>{let E="",q=x.closest("label")||document.querySelector(`label[for="${x.id}"]`);return q?E=q.innerText?.trim()||"":E=x.parentElement?.innerText?.trim()||"",{letter:String.fromCharCode(65+w),text:E}}).filter(x=>x.text.length>0),y=p.innerText||"";h.forEach(x=>{y=y.replace(x.text,"")}),y=y.replace(/\s+/g," ").trim(),y.length>10&&h.length>=2&&(a.detectedQuestions.push({id:`q-${g}`,element:p,text:y.substring(0,500),type:"multiple-choice",options:h,confidence:85}),g++)}}}),a.detectedQuestions.length>0)return}let r=document.querySelectorAll('.mcq__item-text, .mcq__item-text-inner, [class*="mcq__"], [class*="mcq-"]');if(r.length>0){let m=new Set;r.forEach(u=>{let c=u;for(let p=0;p<15&&c.parentElement;p++){c=c.parentElement;let h=c.querySelectorAll('.mcq__item, [class*="mcq__item"]').length,b=c.innerText||"";if(h>=2&&b.length>50&&b.length<5e3&&/\?|pregunta|qué|cuál|cómo|dónde|which|what|how|where/i.test(b)){m.add(c);break}}});let g=0;if(m.forEach(u=>{let c=tt(u);c&&(a.detectedQuestions.push({id:`q-${g}`,element:u,text:c.questionText,type:"multiple-choice",options:c.options,confidence:90}),g++)}),a.detectedQuestions.length>0)return}let d=document.body.querySelectorAll("*"),l=[];d.forEach(m=>{let g=m.textContent||"";if(/pregunta\s*\d+/i.test(g)&&g.length<500){let u=m;for(;u.parentElement&&u.parentElement!==document.body;){let c=u.parentElement.textContent||"";if(/radio_button|checkbox/i.test(c)||u.parentElement.querySelectorAll('input[type="radio"]').length>0){u=u.parentElement;break}if(c.length>3e3)break;u=u.parentElement}l.includes(u)||l.push(u)}});let f=document.body.innerText||"";if(/radio_button_(?:checked|unchecked)/i.test(f)){let m=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),g,u=new Set;for(;g=m.nextNode();)if(/radio_button/i.test(g.textContent||"")){let c=g.parentElement;for(let p=0;p<10&&c;p++){if(/pregunta/i.test(c.textContent||"")){u.add(c);break}c=c.parentElement}}u.forEach(c=>{l.includes(c)||l.push(c)})}l.forEach((m,g)=>{let u=j(m);if(u&&u.length>30){let c=et(u,m);a.detectedQuestions.push({id:`q-${g}`,element:m,text:u,type:"multiple-choice",options:c,confidence:80})}})}function et(e,t){let n=[],s=e.split(/radio_button_(?:checked|unchecked)/i);return s.length>1&&s.slice(1).forEach((i,o)=>{let r=i.trim().split(`
`)[0].trim();r&&r.length>2&&n.push({letter:String.fromCharCode(65+o),text:r})}),n}function tt(e){let t=[],n=e.querySelectorAll('.mcq__item, [class*="mcq__item"]');n.length===0?e.querySelectorAll(".mcq__item-text, .mcq__item-text-inner").forEach((o,r)=>{let d=o.innerText?.trim();d&&d.length>1&&t.push({letter:String.fromCharCode(65+r),text:d})}):n.forEach((i,o)=>{let d=(i.querySelector(".mcq__item-text-inner, .mcq__item-text")||i).innerText?.trim();d&&d.length>1&&t.push({letter:String.fromCharCode(65+o),text:d})});let s=e.innerText||"";return t.forEach(i=>{s=s.replace(i.text,"")}),s=s.replace(/radio_button_(?:checked|unchecked)/gi,"").replace(/\s+/g," ").trim(),s.length<10||t.length<2?null:{questionText:s,options:t}}function nt(){let e=document.querySelectorAll('p, div, span, li, td, th, label, h1, h2, h3, h4, h5, h6, article, section, blockquote, .question, .quiz-question, [class*="question"], [class*="quiz"], [class*="exam"], [data-question], [role="listitem"]'),t=new Set;e.forEach((n,s)=>{let i=j(n);if(!i||i.length<20||t.has(i)||Ee(n,a.detectedQuestions))return;let o=st(i,n);o.isQuestion&&(t.add(i),a.detectedQuestions.push({id:`q-${a.detectedQuestions.length}`,element:n,text:i,type:o.type,options:o.options,confidence:o.confidence}))})}function st(e,t){let n=!1,s="unknown",i=[],o=0;W.questionMarkers.test(e)&&(o+=30);for(let f of W.multipleChoice)if(f.test(e)){s="multiple-choice",o+=40,i=it(e,t);break}if(s==="unknown"){for(let f of W.trueFalse)if(f.test(e)){s="true-false",o+=35,i=["True","False"];break}}if(s==="unknown"){for(let f of W.fillBlank)if(f.test(e)){s="fill-blank",o+=30;break}}let r=(t.className||"").toString().toLowerCase(),d=Array.from(t.attributes).map(f=>f.name.toLowerCase()).join(" ");return/question|quiz|exam|test|assessment/i.test(r+" "+d)&&(o+=25),t.querySelectorAll('input[type="radio"], input[type="checkbox"]').length>0&&(s=s==="unknown"?"multiple-choice":s,o+=35,i.length===0&&(i=ot(t))),n=o>=40,{isQuestion:n,type:s,options:i,confidence:o}}function it(e,t){let n=[],s=/(?:^|\n)\s*([A-Da-d])[\.\)\:]?\s*([^\n]+)/gm,i;for(;(i=s.exec(e))!==null;)n.push({letter:i[1].toUpperCase(),text:i[2].trim()});if(n.length===0){let o=/\(([A-Da-d])\)\s*([^\n\(]+)/gm;for(;(i=o.exec(e))!==null;)n.push({letter:i[1].toUpperCase(),text:i[2].trim()})}if(n.length===0){let o=/(?:^|\n)\s*([1-4])[\.\)\:]?\s*([^\n]+)/gm;for(;(i=o.exec(e))!==null;)n.push({letter:i[1],text:i[2].trim()})}return n}function ot(e){let t=[];return e.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((s,i)=>{let o=e.querySelector(`label[for="${s.id}"]`)||s.closest("label"),r=o?j(o):s.value||`Option ${i+1}`;t.push({letter:String.fromCharCode(65+i),text:(r||"").replace(/^[A-Da-d][\.\)\:]\s*/,"").trim()})}),t}function D(){let e=T("mcq-view"),t=T("object-matching-view"),n=T("matching-view");return e.length>0||t.length>0||n.length>0||document.querySelectorAll(".que.multichoice, .que.truefalse, .que.shortanswer, .que.numerical, .que.essay, .que.match, .que.gapselect").length>0}function G(e,t=10,n=500){let s=0;function i(){s++,D()?e(!0):s<t?setTimeout(i,n):e(!1)}i()}function ce(){let e=[];function t(n){let s=document.createTreeWalker(n,NodeFilter.SHOW_TEXT),i;for(;i=s.nextNode();)if(i.textContent&&/pregunta\s*\d+/i.test(i.textContent)){let r=i.textContent.match(/pregunta\s*(\d+)/i);if(r){let d=parseInt(r[1]),l=i.parentElement;if(l){let f=l.getBoundingClientRect();if(f.top>=-100&&f.top<=window.innerHeight&&f.width>0&&f.height>0){let m=parseFloat(window.getComputedStyle(l).fontSize)||12,g=f.width*f.height,u=Math.abs(f.left+f.width/2-window.innerWidth/2),c=m*10+g/100-u/10;e.push({num:d,top:f.top,fontSize:m,area:g,score:c,text:i.textContent.trim()})}}}}n.querySelectorAll("*").forEach(r=>{r.shadowRoot&&t(r.shadowRoot)})}return t(document),e.length===0?null:(e.sort((n,s)=>s.score-n.score),e[0].num)}async function M(){let e=await at();if(e)return e;let t=ce(),n=rt();if(v("[Study Assist] detectVisibleQuestion:",{visibleQuestionNum:t,questionMapKeys:Object.keys(n),questionMapDetails:Object.entries(n).map(([o,r])=>({num:o,type:r.question?.type,score:r.score,text:r.question?.text?.substring(0,50)}))}),t!==null&&n[t])return n[t].question;let s=null,i=-1/0;for(let o in n){let r=n[o];r.score>i&&(i=r.score,s=r)}return s?s.question:null}async function at(){let e=document.querySelectorAll(".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect");if(e.length===0)return null;let t=window.innerHeight/2,n=null,s=-1/0;for(let i of e){let o=i.getBoundingClientRect();if(o.width===0||o.height===0||!(o.top<window.innerHeight&&o.bottom>0))continue;let l=1e4-Math.abs((o.top+o.bottom)/2-t);l>s&&(s=l,n=i)}return n||(n=e[0]??null),n?await re(n):null}async function re(e){return e.classList.contains("match")?await Se(e):e.classList.contains("shortanswer")?await U(e,"short-answer"):e.classList.contains("numerical")?await U(e,"numerical"):e.classList.contains("gapselect")?await Me(e):await Ae(e)}async function de(){let e=document.querySelectorAll(".que.multichoice, .que.truefalse, .que.match, .que.shortanswer, .que.numerical, .que.gapselect");if(e.length===0)return[];let t=[],n=!1;for(let i of e){let o=i.getBoundingClientRect();o.width===0||o.height===0||(n=!0,!(o.top<window.innerHeight&&o.bottom>0))||t.push({el:i,top:o.top})}if(!n){let i=[];for(let o of e){let r=await re(o);r&&i.push(r)}return i}t.sort((i,o)=>i.top-o.top);let s=[];for(let{el:i}of t){let o=await re(i);o&&s.push(o)}return s}function Z(){let e=document.getElementById("coursetitle");if(e){let i=e.textContent?.trim();if(i&&i.length>2)return i}let t=document.querySelectorAll('.breadcrumb a[href*="/course/view.php"]');for(let i of t){let o=i.getAttribute("title");if(o&&o.length>2)return o;let r=i.querySelector('span[itemprop="title"]');if(r){let d=r.textContent?.trim();if(d&&d.length>2)return d}}let n=document.title.trim(),s=n.lastIndexOf(":");if(s!==-1&&s<n.length-1){let i=n.substring(s+1).trim();if(i.length>3)return i}}async function Ae(e){let t=Z(),n=e.classList.contains("truefalse"),s=e.querySelector(".qno"),i=s?parseInt(s.textContent?.trim()||"1"):1,o=e.querySelector(".qtext"),r="",d=[];if(o){r=o.textContent?.trim()||"";let g=o.querySelectorAll("img:not(.questionflagimage)");for(let u of g)if(!(u.width<50||u.height<50))if(I(u.src))d.push({url:u.src,mediaType:"image/jpeg",alt:u.alt||"Question image",location:"question"});else{let c=await $(u);c&&d.push({base64:c.base64,mediaType:c.mediaType,alt:u.alt||"Question image",location:"question"})}}let l=e.querySelector(".answer"),f=[];if(l){let g=l.querySelectorAll(":scope > div.r0, :scope > div.r1");for(let u of g){let c=u.querySelector(".answernumber"),p="";c&&(p=(c.textContent?.trim()||"").replace(".","").toUpperCase());let h=u.querySelector(".flex-fill, [data-region='answer-label'] > div:not(.answernumber)"),b="",y=null;if(h){b=h.textContent?.trim()||"";let x=h.querySelector("img:not(.questionflagimage)");if(x&&x.width>=50&&x.height>=50)if(I(x.src))y={url:x.src,mediaType:"image/jpeg",alt:x.alt||`Option ${p} image`};else{let w=await $(x);w&&(y={base64:w.base64,mediaType:w.mediaType,alt:x.alt||`Option ${p} image`})}}else{let x=u.querySelector("[data-region='answer-label']");if(x){b=x.textContent?.trim()||"",c&&(b=b.replace(c.textContent||"","").trim());let w=x.querySelector("img:not(.questionflagimage)");if(w&&w.width>=50&&w.height>=50)if(I(w.src))y={url:w.src,mediaType:"image/jpeg",alt:w.alt||`Option ${p} image`};else{let E=await $(w);E&&(y={base64:E.base64,mediaType:E.mediaType,alt:w.alt||`Option ${p} image`})}}}if(!b){let x=u.querySelector("label");x&&(b=x.textContent?.trim()||"")}if(b||(b=u.textContent?.trim()||"",c&&c.textContent&&(b=b.replace(c.textContent,"").trim())),n){let x=b.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();/(^|\b)(true|verdadero)(\b|$)/i.test(x)?p="V":/(^|\b)(false|falso)(\b|$)/i.test(x)&&(p="F")}p||(p=String.fromCharCode(65+f.length)),(b||y)&&f.push({letter:p,text:b||`[Image: ${y?.alt||"option"}]`,image:y})}}return!(r||d.length>0)||f.length<2?null:{id:`moodle-q-${i}`,type:n?"true-false":"multiple-choice",text:r,options:f,element:e,questionNumber:i,platform:"moodle",images:d,confidence:95,courseName:t}}async function Se(e){let t=Z(),n=e.querySelector(".qno"),s=n?parseInt(n.textContent?.trim()||"1"):1,o=(e.querySelector(".qtext")?.textContent||"").replace(/\s+/g," ").trim();if(!o)return null;let r=e.querySelectorAll("table.answer tbody tr");if(r.length===0)return null;let d=[],l=null;for(let[f,m]of Array.from(r).entries()){let u=(m.querySelector("td.text")?.textContent||"").replace(/\s+/g," ").trim();if(u&&d.push({letter:String.fromCharCode(65+f),text:u}),!l){let c=m.querySelector("td.control select");if(c){l=[];for(let p of Array.from(c.querySelectorAll("option"))){let h=parseInt(p.getAttribute("value")||"0");h>0&&l.push({index:h,text:(p.textContent||"").replace(/\s+/g," ").trim()})}}}}return d.length===0||!l||l.length===0?null:{id:`moodle-q-${s}`,type:"matching",text:o,options:[],element:e,questionNumber:s,platform:"moodle",confidence:95,courseName:t,categories:d,matchingOptions:l}}async function U(e,t){let n=Z(),s=e.querySelector(".qno"),i=s?parseInt(s.textContent?.trim()||"1"):1,r=e.querySelector(".qtext")?.textContent?.trim()||"";return r?{id:`moodle-q-${i}`,type:t,text:r,options:[],element:e,questionNumber:i,platform:"moodle",confidence:95,courseName:n}:null}async function Me(e){let t=Z(),n=e.querySelector(".qno"),s=n?parseInt(n.textContent?.trim()||"1"):1,i=e.querySelector(".qtext");if(!i)return null;let o=Array.from(i.querySelectorAll("select"));if(o.length===0)return null;let r=i.cloneNode(!0),d=Array.from(r.querySelectorAll("select")),l=[],f={},m=new Map,g=0;for(let c=0;c<o.length;c++){let p=o[c],h=d[c],b=c+1,y=[];for(let E of Array.from(p.querySelectorAll("option")))parseInt(E.getAttribute("value")||"0")>0&&y.push(E.textContent?.trim()||"");let x=y.join("|"),w;m.has(x)?w=m.get(x):(w=String.fromCharCode(65+g),g++,m.set(x,w),f[w]=y),h.replaceWith(`[[${b}]]`),l.push({index:b,groupId:w,leftContext:"",rightContext:""})}let u=(r.textContent||"").replace(/\s+/g," ").trim();for(let c of l){let p=`[[${c.index}]]`,h=u.indexOf(p);h!==-1&&(c.leftContext=u.substring(0,h).slice(-60).trim(),c.rightContext=u.substring(h+p.length,h+p.length+60).trim())}return!u||l.length===0?null:{id:`moodle-q-${s}`,type:"select-missing-words",text:u,options:[],element:e,questionNumber:s,platform:"moodle",confidence:95,courseName:t,selectGaps:l,selectChoices:f}}function rt(){let e={},t=window.innerHeight/2,n=window.innerWidth/2,s=1e6,i=T("mcq-view"),o=T("object-matching-view"),r=T("matching-view");for(let d of i){let l=d.getBoundingClientRect();if(!(l.width>0&&l.height>0))continue;let m=ae(d);if(m===null)continue;let u=1e4-Math.sqrt(Math.pow(l.left+l.width/2-n,2)+Math.pow(l.top+l.height/2-t,2)),c=dt(d,m);!c||c.options.length<2||(!e[m]||e[m].score<u)&&(e[m]={type:"mcq",question:c,score:u,element:d})}for(let d of o){let l=d.getBoundingClientRect();if(!(l.width>0&&l.height>0))continue;let m=ae(d),g=m!==null?m:s++,c=1e4-Math.sqrt(Math.pow(l.left+l.width/2-n,2)+Math.pow(l.top+l.height/2-t,2)),p=lt(d,g);p&&(!e[g]||e[g].score<c)&&(e[g]={type:"matching",question:p,score:c,element:d})}for(let d of r){let l=d.getBoundingClientRect();if(!(l.width>0&&l.height>0))continue;let m=ae(d),g=m!==null?m:s++,c=1e4-Math.sqrt(Math.pow(l.left+l.width/2-n,2)+Math.pow(l.top+l.height/2-t,2)),p=ct(d,g);p&&(!e[g]||e[g].score<c)&&(e[g]={type:"matching",question:p,score:c,element:d})}return e}function ae(e){let t=e.parentElement||e.getRootNode()?.host,n=0,s=15;for(;t&&n<s;){let f=t.children;for(let u of f){if(u===e)continue;let p=(u.textContent||"").match(/pregunta\s*(\d+)/i);if(p)return parseInt(p[1]);if(u.shadowRoot){let b=(u.shadowRoot.textContent||"").match(/pregunta\s*(\d+)/i);if(b)return parseInt(b[1])}}let g=we(t).match(/pregunta\s*(\d+)/i);if(g)return parseInt(g[1]);if(t.shadowRoot){let c=(t.shadowRoot.textContent||"").match(/pregunta\s*(\d+)/i);if(c)return parseInt(c[1])}if(t.parentElement)t=t.parentElement;else if(t.getRootNode()?.host)t=t.getRootNode().host;else break;n++}if(e.shadowRoot){let m=(e.shadowRoot.textContent||"").match(/pregunta\s*(\d+)/i);if(m)return parseInt(m[1])}let i=e.getBoundingClientRect();if(i.width===0||i.height===0)return null;let o=[];function r(f){let m=document.createTreeWalker(f,NodeFilter.SHOW_TEXT),g;for(;g=m.nextNode();)if(g.textContent&&/pregunta\s*\d+/i.test(g.textContent)){let c=g.textContent.match(/pregunta\s*(\d+)/i);if(c&&g.parentElement){let p=g.parentElement.getBoundingClientRect();p.width>0&&p.height>0&&o.push({num:parseInt(c[1]),rect:p,element:g.parentElement})}}f.querySelectorAll("*").forEach(c=>{c.shadowRoot&&r(c.shadowRoot)})}r(document);let d=null,l=1/0;for(let f of o){let m=i.top-f.rect.bottom,g=Math.abs(i.left+i.width/2-(f.rect.left+f.rect.width/2));if(m>=-50&&m<500){let u=Math.abs(m)+g*.5;u<l&&(l=u,d=f)}}return d?d.num:null}function lt(e,t){let n=e.shadowRoot;if(!n)return null;let s="",i=T(".component__body-inner, .objectMatching__body-inner",n);i.length>0&&(s=i[0].textContent?.trim()||"");let o=T("object-matching-dropdown-view",n);if(o.length>0){let m=[],g=new Set;o.forEach((c,p)=>{let h=c.shadowRoot;if(!h)return;let b=h.querySelector(".category-item-number"),y=h.querySelector(".matching__item-title_inner");if(y){let E=b&&b.textContent?.trim()||String.fromCharCode(65+p),q=y.textContent?.trim()||"";q&&!q.includes("objetivo dejado en blanco")&&m.push({letter:E,text:q})}if(h.querySelector(".dropdown__btn")){let E=h.querySelector(".dropdown__inner")?.textContent?.trim();E&&!E.includes("s\xE9lectionner")&&!E.includes("Seleccione")&&!E.includes("Select")&&g.add(E)}h.querySelectorAll(".dropdown__item-inner").forEach(E=>{let q=E.textContent?.trim();q&&!q.includes("s\xE9lectionner")&&!q.includes("Seleccione")&&!q.includes("Select")&&g.add(q)})});let u=Array.from(g).map((c,p)=>({index:p+1,text:c}));if(m.length>=2)return{id:`matching-${t}`,type:"matching",matchingStyle:"object-dropdown",questionNumber:t,text:s||`Pregunta ${t||"?"}`,categories:m,matchingOptions:u.length>0?u:[{index:1,text:"(options in dropdown)"}],element:e,options:[],confidence:95}}let r=[];T(".objectMatching-category-item",n).forEach((m,g)=>{let u=m.querySelector(".category-item-text"),c=m.querySelector(".category-item-number");if(u){let p=u.textContent?.trim()||"",h=c&&c.textContent?.trim()||String.fromCharCode(65+g);r.push({letter:h,text:p})}});let l=[];return T(".objectMatching-option-item",n).forEach((m,g)=>{let u=m.querySelector(".category-item-text");if(u){let c=u.textContent?.trim()||"";l.push({index:g+1,text:c})}}),r.length>=2&&l.length>=2?{id:`matching-${t}`,type:"matching",questionNumber:t,text:s||`Pregunta ${t||"?"}`,categories:r,matchingOptions:l,element:e,options:[],confidence:95}:null}function ct(e,t){let n=e.shadowRoot;if(!n)return null;let s="",i=T(".component__body-inner, .matching__body-inner",n);i.length>0&&(s=i[0].textContent?.trim()||"");let o=[],r=new Set;T("matching-dropdown-view",n).forEach((f,m)=>{let g=f.shadowRoot;if(!g)return;let u=g.querySelector(".matching__item-title_inner");if(u){let p=u.textContent?.trim()||"";o.push({index:m+1,text:p})}g.querySelectorAll(".dropdown__item-inner").forEach(p=>{let h=p.textContent?.trim();h&&h!=="Seleccione una opci\xF3n"&&r.add(h)})});let l=Array.from(r).map((f,m)=>({letter:String.fromCharCode(65+m),text:f}));return o.length>=2&&l.length>=1?{id:`matching-dropdown-${t}`,type:"matching",matchingStyle:"dropdown",questionNumber:t,text:s||`Pregunta ${t||"?"}`,categories:l,matchingOptions:o,element:e,options:[],confidence:95}:null}function dt(e,t){let n=e.shadowRoot;if(!n)return null;let s="",i=T(".mcq__body-inner",n);i.length>0&&(s=i[0].textContent?.trim()||"");let o="";if(o=N(n),!o){let l=e.parentElement,f=0;for(;l&&f<10&&(o=N(l),!(o||l.shadowRoot&&(o=N(l.shadowRoot),o)));){if(l.tagName&&(l.tagName.toLowerCase().includes("block-view")||l.tagName.toLowerCase().includes("tabs-view")||l.classList?.contains("component__container"))){let m=l.querySelectorAll("*");for(let g of m)if(g.shadowRoot&&(o=N(g.shadowRoot),o))break;if(o)break}l=l.parentElement,f++}}o||(v("[Study Assist] Searching entire document for diagram descriptions..."),o=N(document.body)),o&&(v("[Study Assist] Adding diagram description to question context"),s=s+`

[DIAGRAM DESCRIPTION]
`+o);let r=T(".mcq__item-text-inner",n),d=[];return r.forEach((l,f)=>{let m=l.textContent?.trim()||"";m&&m.length>0&&d.push({letter:String.fromCharCode(65+f),text:m})}),d.length<2?null:{id:`mcq-${t}`,type:"multiple-choice",questionNumber:t,text:s||`Pregunta ${t||"?"}`,options:d,element:e,confidence:95}}function Le(e){let{frameHasQuizContent:t,waitForQuizContent:n,handleQuickClick:s}=e,i=document.getElementById("study-assist-overlay");i&&i.remove();let o=document.getElementById("study-assist-quick-container");o&&o.remove();let r=document.getElementById("study-assist-quick");r&&r.remove(),a.settings.quickMode?t&&t()?k({handleQuickClick:s}):n&&n(d=>{d&&k({handleQuickClick:s})}):ut(e.showQuestionsSummary)}function ut(e){let t=document.createElement("div");t.id="study-assist-overlay",t.innerHTML=`
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
  `,document.body.appendChild(t);let n=t.querySelector(".study-assist-close");n&&n.addEventListener("click",z);let s=t.querySelector(".study-assist-minimize");if(s&&s.addEventListener("click",mt),e){let i=t.querySelector(".study-assist-refresh");i&&i.addEventListener("click",e)}pt(t)}function ue(){let e=document.getElementById("study-assist-overlay");e&&(e.classList.add("study-assist-visible"),a.overlayVisible=!0)}function z(){let e=document.getElementById("study-assist-overlay");e&&(e.classList.remove("study-assist-visible"),a.overlayVisible=!1)}function mt(){let e=document.getElementById("study-assist-overlay");e&&e.classList.toggle("study-assist-minimized")}function pt(e){let t=e.querySelector(".study-assist-header");if(!t)return;let n=!1,s,i,o,r;t.addEventListener("mousedown",d=>{d.target.tagName!=="BUTTON"&&(n=!0,o=d.clientX-(e.offsetLeft||0),r=d.clientY-(e.offsetTop||0))}),document.addEventListener("mousemove",d=>{n&&(d.preventDefault(),s=d.clientX-o,i=d.clientY-r,e.style.left=`${s}px`,e.style.top=`${i}px`,e.style.right="auto",e.style.bottom="auto")}),document.addEventListener("mouseup",()=>{n=!1})}function ke(){v("[Study Assist] ALT+Q pressed - toggling SA button visibility");let e=document.getElementById("study-assist-quick-container");if(e){let t=e.style.display==="none";e.style.display=t?"":"none",a.saButtonHidden=!t;try{chrome.runtime.sendMessage({type:"SET_CONTENT_PREFERENCE",enabled:a.saButtonHidden}).catch(()=>{})}catch{}v(`[Study Assist] SA button ${t?"shown":"hidden"}, CTRL webex toggle ${t?"enabled":"disabled"}`)}else v("[Study Assist] SA button container not found")}function X(){let e=document.getElementById("study-assist-quick"),t=document.getElementById("study-assist-quick-container");e&&(e.innerHTML="<span>SA</span>",e.classList.remove("has-answer","matching-answer","multi-answer","multi-answer-large")),t&&t.classList.remove("matching-mode"),a.lastAnsweredQuestionNum=null,a.hasValidAnswer=!1}function k(e){let{handleQuickClick:t}=e,n=document.createElement("div");n.id="study-assist-quick-container";let s=a.settings.buttonPosition||"bottom-right";n.setAttribute("data-position",s);let i=document.createElement("div");i.id="study-assist-quick",i.innerHTML="<span>SA</span>",n.appendChild(i),document.body.appendChild(n),a.saButtonHidden&&(n.style.display="none"),t&&i.addEventListener("click",o=>{o.isTrusted&&a.isActive&&a.isDomainAllowed&&t(o)}),ft()}function ft(){let e="study-assist-webex-hide-style",t=window.self===window.top;if(document.getElementById(e))return;let n=document.createElement("style");n.id=e,n.textContent=`
    /* Class to hide Webex button */
    .webex-hidden-by-sa {
      visibility: hidden !important;
    }
    /* Set Webex button icon size */
    .fabActionBtnIconContainer--RPrZH img {
      width: 65px !important;
      height: 65px !important;
    }
  `,document.head.appendChild(n);let s=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");s&&o(s),new MutationObserver(l=>{l.forEach(f=>{f.addedNodes.forEach(m=>{if(m.nodeType===Node.ELEMENT_NODE){let g=m;(g.id==="webexFabActionBtn"||g.classList.contains("fabActionBtn--WND8X"))&&o(g);let u=g.querySelector?.("#webexFabActionBtn, .fabActionBtn--WND8X");u&&o(u)}})})}).observe(document.body,{childList:!0,subtree:!0});function o(l){if(!l)return;let f=l.querySelector(".fabActionBtnIconContainer--RPrZH img");f&&(f.style.setProperty("width","55px","important"),f.style.setProperty("height","55px","important"))}function r(){let l=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");l&&l.classList.add("webex-hidden-by-sa")}function d(){let l=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");l&&l.classList.remove("webex-hidden-by-sa")}t&&window.addEventListener("message",l=>{l.data==="study-assist-hide-webex"?r():l.data==="study-assist-show-webex"&&d()}),document.addEventListener("keydown",l=>{if(l.key==="Control"&&(r(),!t))try{window.parent.postMessage("study-assist-hide-webex","*")}catch{}}),document.addEventListener("keyup",l=>{if(l.key==="Control"&&(d(),!t))try{window.parent.postMessage("study-assist-show-webex","*")}catch{}})}function K(e){P(),a.detectedQuestions.forEach((t,n)=>{let s=t.element;s.classList.add("study-assist-question-highlight"),s.dataset.studyAssistId=t.id;let i=document.createElement("div");i.className="study-assist-question-badge",i.textContent=String(n+1),i.title=`Pregunta ${n+1} - Clic para analizar`,i.addEventListener("click",o=>{!o.isTrusted||!a.isActive||!a.isDomainAllowed||(o.stopPropagation(),e&&e(t))}),s.style.position=s.style.position||"relative",s.appendChild(i)})}function P(){document.querySelectorAll(".study-assist-question-highlight").forEach(e=>{e.classList.remove("study-assist-question-highlight"),delete e.dataset.studyAssistId}),document.querySelectorAll(".study-assist-question-badge").forEach(e=>{e.remove()})}function Ce(e,t){let n=document.getElementById("study-assist-overlay");if(!n)return;let s=n.querySelector(".study-assist-results");if(!s)return;let i;if(e.type==="matching"){let r=(e.categories||[]).map(l=>`<div class="study-assist-matching-item"><strong>${l.letter}.</strong> ${S(l.text)}</div>`).join(""),d=(e.matchingOptions||[]).map(l=>`<div class="study-assist-matching-item"><strong>${l.index}.</strong> ${S(l.text)}</div>`).join("");i=`
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
                ${d}
              </div>
            </div>
          </div>
        </div>
        <button class="study-assist-analyze-btn-large">Analizar Pregunta</button>
      </div>
    `}else{let r=(e.options||[]).map(d=>`<div class="study-assist-option-item"><strong>${d.letter}.</strong> ${S(d.text)}</div>`).join("");i=`
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
    `}s.innerHTML=i,a.currentVisibleQuestion=e;let o=s.querySelector(".study-assist-analyze-btn-large");o&&o.addEventListener("click",r=>{!r.isTrusted||!a.isActive||!a.isDomainAllowed||t&&t(e)}),ue()}async function Qe(e,t){if(!document.getElementById("study-assist-overlay"))return;let s=await e();if(s){Ce(s,t);return}let i=null,o=-1;if(a.detectedQuestions.forEach(r=>{let d=qe(r.element);d>o&&(o=d,i=r)}),!i&&a.detectedQuestions.length>0&&(i=a.detectedQuestions[0]),i){Ce(i,t);return}gt()}function gt(){let e=document.getElementById("study-assist-overlay");if(!e||!a.overlayVisible)return;let t=e.querySelector(".study-assist-results");t&&(t.innerHTML=`
    <div class="study-assist-empty">
      <p>No se detect\xF3 una pregunta. Haz clic en \u21BB para reintentar.</p>
    </div>
  `)}function _e(){let e=document.getElementById("study-assist-overlay");if(!e)return;let t=e.querySelector(".study-assist-loading");t&&(t.style.display="flex")}function F(){let e=document.getElementById("study-assist-overlay");if(!e)return;let t=e.querySelector(".study-assist-loading");t&&(t.style.display="none")}function Ie(e,t,n){let s=document.getElementById("study-assist-overlay");if(!s)return;let i=s.querySelector(".study-assist-results");if(!i)return;i.innerHTML=`
    <div class="study-assist-analysis">
      <button class="study-assist-back-btn">\u2190 Volver a Preguntas</button>
      
      <div class="study-assist-question-box">
        <h4>\u{1F4DD} Pregunta</h4>
        <p>${S(ne(t.text,300))}</p>
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
          ${se(e)}
        </div>
      </div>
      
      <div class="study-assist-disclaimer">
          \u26A0\uFE0F Esta es una ayuda de aprendizaje generada por IA. Verifica siempre la informaci\xF3n y \xFAsala para mejorar tu comprensi\xF3n, no como sustituto del estudio.
      </div>
    </div>
  `;let o=i.querySelector(".study-assist-back-btn");o&&o.addEventListener("click",()=>{n&&n()}),ue()}function Y(e,t,n,s=!1,i){let o=document.getElementById("study-assist-overlay");if(!o)return;let r=o.querySelector(".study-assist-results");if(!r)return;if(s){r.innerHTML=`
      <div class="study-assist-analysis">
        <button class="study-assist-back-btn">\u2190 Volver a Preguntas</button>
        
        <div class="study-assist-question-box">
          <h4>\u{1F4DD} Pregunta</h4>
          <p>${S(ne(t.text,300))}</p>
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
    `;let l=r.querySelector(".study-assist-back-btn");l&&l.addEventListener("click",()=>{n&&n()}),ue();return}let d=document.getElementById("study-assist-stream-content");if(d){let l=i?"":'<span class="study-assist-stream-cursor">\u258A</span>';d.innerHTML=se(e)+l,d.scrollTop=d.scrollHeight}if(i){let l=document.getElementById("study-assist-token-info");l&&(l.style.display="block",l.innerHTML=`
        <span title="Tokens de entrada">\u{1F4E5} ${i.inputTokens}</span>
        <span title="Tokens de salida">\u{1F4E4} ${i.outputTokens}</span>
        <span title="Costo estimado">\u{1F4B0} $${i.cost.toFixed(6)}</span>
      `)}}function me(e,t){let n=document.getElementById("study-assist-overlay");if(!n)return;let s=n.querySelector(".study-assist-results");if(!s)return;s.innerHTML=`
    <div class="study-assist-error">
      <span class="study-assist-error-icon">\u26A0\uFE0F</span>
      <h3>Error de An\xE1lisis</h3>
      <p>${S(e)}</p>
      <button class="study-assist-retry-btn">Reintentar</button>
    </div>
  `;let i=s.querySelector(".study-assist-retry-btn");i&&i.addEventListener("click",()=>{t&&t()})}function De(e){ht(e)}function ht(e){let{triggerQuickAnalysis:t,reloadQuickMode:n,toggleSAButtonVisibility:s,cancelCurrentRequest:i}=e,o="study-assist-webex-hide-style",r="study-assist-keyboard-injected",d=window.self===window.top,l=document.documentElement.hasAttribute(r);if(!document.getElementById(o)){let p=document.createElement("style");p.id=o,p.textContent=`
    /* Class to hide Webex button */
    .webex-hidden-by-sa {
      visibility: hidden !important;
    }
    /* Set Webex button icon size */
    .fabActionBtnIconContainer--RPrZH img {
      width: 65px !important;
      height: 65px !important;
    }
  `,(document.head??document.documentElement).appendChild(p)}if(l)return;document.documentElement.setAttribute(r,"1");let f=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");f&&g(f),new MutationObserver(p=>{p.forEach(h=>{h.addedNodes.forEach(b=>{if(b.nodeType===Node.ELEMENT_NODE){let y=b;(y.id==="webexFabActionBtn"||y.classList.contains("fabActionBtn--WND8X"))&&g(y);let x=y.querySelector?.("#webexFabActionBtn, .fabActionBtn--WND8X");x&&g(x)}})})}).observe(document.body??document.documentElement,{childList:!0,subtree:!0});function g(p){if(!p)return;let h=p.querySelector(".fabActionBtnIconContainer--RPrZH img");h&&(h.style.setProperty("width","55px","important"),h.style.setProperty("height","55px","important"))}function u(){let p=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");p&&p.classList.add("webex-hidden-by-sa")}function c(){let p=document.querySelector("#webexFabActionBtn, .fabActionBtn--WND8X");p&&p.classList.remove("webex-hidden-by-sa")}d&&window.addEventListener("message",p=>{p.data==="study-assist-hide-webex"?u():p.data==="study-assist-show-webex"&&c()}),document.addEventListener("keydown",async p=>{if(!(!p.isTrusted||!a.isActive||!a.isDomainAllowed)){if(p.key==="Control"){if(a.saButtonHidden)return;if(u(),!d)try{window.parent.postMessage("study-assist-hide-webex","*")}catch{}try{window.top?.postMessage("study-assist-hide-webex","*")}catch{}}if(p.altKey&&!p.repeat&&(p.key==="w"||p.key==="W")){let h=document.activeElement;!J(h)&&a.settings.quickMode&&(p.preventDefault(),n())}if(p.altKey&&!p.repeat&&(p.key==="q"||p.key==="Q")){let h=document.activeElement;J(h)||(p.preventDefault(),s())}if(p.altKey&&!p.repeat&&(p.key==="x"||p.key==="X")){let h=document.activeElement;!J(h)&&a.isRequestInProgress&&(p.preventDefault(),i())}if(p.key==="Shift"&&!p.repeat){if(p.ctrlKey){try{if((await chrome.runtime.sendMessage({type:"GET_CONTENT_SETTINGS"}))?.settings?.hasValidator!==!0)return}catch(w){v("[Study Assist] Could not check validator selection:",w);return}if(!a.isActive||!a.isDomainAllowed)return}let h=document.activeElement,b=J(h),y=document.getElementById("study-assist-quick"),x=y&&y.classList.contains("loading");!b&&y&&(p.preventDefault(),x&&p.ctrlKey?(v("[Study Assist] CTRL+SHIFT pressed while loading - cancelling current request"),chrome.runtime.sendMessage({type:"CANCEL_ANALYSIS",skipPrimary:!0}).then(w=>{w&&w.cancelled&&v("[Study Assist] Request cancelled, validator will take over")}).catch(w=>{v("[Study Assist] Cancel message error:",w)})):x||(a.skipPrimary=p.ctrlKey,a.skipPrimary&&v("[Study Assist] CTRL+SHIFT pressed - will skip primary, use validator directly"),t()))}}}),document.addEventListener("keyup",p=>{if(p.key==="Control"){if(a.saButtonHidden)return;if(c(),!d)try{window.parent.postMessage("study-assist-show-webex","*")}catch{}try{window.top?.postMessage("study-assist-show-webex","*")}catch{}}}),window.addEventListener("blur",()=>{c();try{window.top?.postMessage("study-assist-show-webex","*")}catch{}})}function J(e){return!!(e&&(e.tagName==="INPUT"||e.tagName==="TEXTAREA"||e.isContentEditable||e.closest('[contenteditable="true"]')))}function yt(){return document.getElementById("study-assist-qa-sandbox")!==null}function Q(){let e=yt(),t=Number(document.documentElement.dataset.studyAssistQaTabId);return e&&Number.isInteger(t)&&t>0?{qaMode:!0,qaTabId:t}:{qaMode:e}}async function Re(e){let t=e.qaTabId;if(typeof t!="number"||!Number.isInteger(t)||t<=0)throw new Error("QA tab unavailable. Reopen QA from the dashboard.");let n=await chrome.runtime.sendMessage({type:"REGISTER_QA_TAB",tabId:t});if(n?.success!==!0)throw new Error(n?.error||"QA tab registration failed");H&&B("QA tab registration refreshed",{tabId:t})}function He(e,t=[]){let n=e.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();if(/\b(V|TRUE|VERDADERO)\b/.test(n))return"V";if(/\b(F|FALSE|FALSO)\b/.test(n))return"F";let s=n.match(/\b([A-Z])\b/)?.[1];if(s){let i=t.find(o=>o.letter.toUpperCase()===s);if(i){let o=i.text.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase();if(/\b(TRUE|VERDADERO)\b/.test(o))return"V";if(/\b(FALSE|FALSO)\b/.test(o))return"F"}}return"?"}var A=0,V=new Set,O=new Map;function fe(){v("[Study Assist] ALT+X pressed - cancelling current request"),A++;for(let t of O.values())t();O.clear(),V.clear();let e=document.getElementById("study-assist-quick");a.requestCancelled=!0,a.slowConnectionTimer&&(clearTimeout(a.slowConnectionTimer),a.slowConnectionTimer=null),e&&(e.innerHTML="<span>SA</span>",e.classList.remove("loading","slow-connection")),F(),a.isRequestInProgress=!1,v("[Study Assist] Request cancelled by user")}function Ne(e={detectVisibleQuestion:M,startQuestionChangeObserver:C}){v("[Study Assist] ALT+W pressed - reloading quick mode");let t=document.getElementById("study-assist-quick");t?(v("[Study Assist] Applying reloading animation to SA button"),t.classList.add("reloading"),setTimeout(()=>{t.classList.remove("reloading")},500),vt(),v("[Study Assist] Quick mode reloaded, question re-detected")):a.settings.quickMode&&D()?(k({handleQuickClick:n=>_(n)}),v("[Study Assist] Quick button created")):a.settings.quickMode?G(n=>{n?(k({handleQuickClick:s=>_(s)}),v("[Study Assist] Quick button created after waiting")):v("[Study Assist] No quiz content found in this frame")}):v("[Study Assist] Quick mode is disabled in settings")}function Pe(e={detectVisibleQuestion:M,startQuestionChangeObserver:C}){v("[Study Assist] SHIFT pressed - triggering quick analysis");let t=document.getElementById("study-assist-quick");if(t){if(t.classList.contains("loading")){v("[Study Assist] Already loading, ignoring");return}_()}else v("[Study Assist] Quick button not found, trying to create first"),a.settings.quickMode&&D()&&(k({handleQuickClick:n=>_(n)}),setTimeout(()=>{document.getElementById("study-assist-quick")&&_()},100))}function C(){a.questionChangeObserver&&(a.questionChangeObserver.disconnect(),a.questionChangeObserver=null),a.questionChangeInterval&&(clearInterval(a.questionChangeInterval),a.questionChangeInterval=null),a.questionChangeInterval=setInterval(()=>{if(a.lastAnsweredQuestionNum===null){a.questionChangeInterval&&(clearInterval(a.questionChangeInterval),a.questionChangeInterval=null);return}try{let e=ce();if(H&&v(`[Observer] lastAnswered: ${a.lastAnsweredQuestionNum}, currentNum: ${e}, pending: ${a.pendingQuestionChange}`),e!==null&&e!==a.lastAnsweredQuestionNum){if(!a.pendingQuestionChange||a.pendingQuestionChange!==e){a.pendingQuestionChange=e,v(`[Observer] Question change detected: ${a.lastAnsweredQuestionNum} \u2192 ${e}, waiting for confirmation...`);return}v("[Study Assist] Question changed from",a.lastAnsweredQuestionNum,"to",e),a.pendingQuestionChange=null,X(),a.questionChangeInterval&&(clearInterval(a.questionChangeInterval),a.questionChangeInterval=null)}else e===a.lastAnsweredQuestionNum&&(a.pendingQuestionChange=null)}catch{}},1e3)}async function vt(){let e=document.getElementById("study-assist-quick"),t=document.getElementById("study-assist-quick-container");e&&(e.classList.add("reloading"),a.hasValidAnswer=!1,e.innerHTML="<span>SA</span>",e.classList.remove("has-answer","multi-answer","multi-answer-large","matching-answer"),t&&t.classList.remove("matching-mode"),M().then(n=>{setTimeout(()=>{e.classList.remove("reloading")},500)}))}var pe=48;async function Be(e){let t=[];if(v("[Study Assist] sendImages setting:",a.settings.sendImages),a.settings.sendImages){if(e.platform==="moodle"){if(e.images&&e.images.length>0&&(t=[...e.images],v("[Study Assist] Moodle images found:",t.length)),e.options)for(let n of e.options)n.image&&t.push({...n.image,location:`option_${n.letter}`})}else if(e.element)try{v("[Study Assist] Extracting images from NetAcad element:",e.element.tagName),t=await ie(e.element),v("[Study Assist] NetAcad images extracted:",t.length)}catch(n){console.error("[Study Assist] Image extraction error:",n)}}else v("[Study Assist] sendImages is OFF - no images will be sent");return v("[Study Assist] Total images to send:",t.length),t}function Oe(e,t,n){return e.type==="matching"?{questionText:e.text,questionType:"matching",matchingStyle:e.matchingStyle||"drag-drop",categories:e.categories,matchingOptions:e.matchingOptions,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:n,courseName:e.courseName,...Q()}:e.type==="select-missing-words"?{questionText:e.text,questionType:"select-missing-words",selectGaps:e.selectGaps,selectChoices:e.selectChoices,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:n,courseName:e.courseName,...Q()}:e.type==="short-answer"||e.type==="numerical"?{questionText:e.text,questionType:e.type,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:n,courseName:e.courseName,...Q()}:{questionText:e.text,questionType:e.type==="true-false"?"true-false":"multiple-choice",options:e.options,images:t,pageTitle:document.title,pageUrl:window.location.href,responseMode:"quick",skipPrimary:n,courseName:e.courseName,...Q()}}async function $e(e){if(e.qaMode===!0){let t=A;if(await Re(e),t!==A)throw new Error("Analysis cancelled")}return new Promise((t,n)=>{let s=chrome.runtime.connect({name:"quick-analysis"});V.add(s);let i=!1,o=(f,m)=>{i||(i=!0,clearTimeout(r),V.delete(s),O.delete(s),s.onMessage.removeListener(l),s.onDisconnect.removeListener(d),s.disconnect(),m?n(m):t(f))},r=setTimeout(()=>o(void 0,new Error("Analysis timeout")),36e4);O.set(s,()=>o(void 0,new Error("Analysis cancelled")));let d=()=>o(void 0,new Error("Analysis connection lost or cancelled")),l=f=>{i||(f.type==="STATUS"&&f.status?qt(f.status):f.type==="RESULT"&&f.result&&o(f.result))};s.onMessage.addListener(l),s.onDisconnect.addListener(d);try{s.postMessage({type:"ANALYZE_QUESTION",context:e})}catch(f){o(void 0,f)}})}function bt(e,t){let n=t.trim();if(e.type==="matching"||e.type==="select-missing-words")return n.toUpperCase().trim().slice(0,pe);if(e.type==="short-answer"||e.type==="numerical"){let d=n||"?";return d.length>pe?d.slice(0,pe-1)+"\u2026":d}let s=n.toUpperCase();if(e.type==="true-false")return He(n,e.options||[]);let i=s.match(/^([A-Z])\s*,\s*([A-Z])(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?$/),o=i?null:s.match(/^([A-Z])\s*\/\s*([A-Z])(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?$/);if(i||o){let d=i||o;return[d[1],d[2],d[3],d[4],d[5]].filter(Boolean).join(",")}let r=s.match(/\b([A-Z])\b/);return r?r[1]:"?"}async function xt(e,t={detectVisibleQuestion:M,startQuestionChangeObserver:C}){let n=A,s=document.getElementById("study-assist-quick");if(!s)return;let i=document.getElementById("study-assist-quick-container"),o=a.skipPrimary;a.skipPrimary=!1;let r=[],d=!1;for(let f=0;f<e.length;f++){let m=e[f];if(a.requestCancelled||n!==A){v("[Study Assist] Multi request cancelled, stopping batch");break}v("[Study Assist] Multi analyzing question:",{index:f+1,total:e.length,questionNumber:m.questionNumber,questionType:m.type});try{let g=await Be(m);if(n!==A)return;let u=Oe(m,g,o),c=await $e(u);if(a.requestCancelled||n!==A){v("[Study Assist] Multi request cancelled, ignoring response");break}let p=m.questionNumber??f+1;c.success&&c.result?(d=!0,r.push(`${p}:${bt(m,c.result)}`)):r.push(`${p}:?`)}catch(g){console.error("[Study Assist] Multi analysis error:",g);let u=m.questionNumber??f+1;r.push(`${u}:?`)}}if(a.slowConnectionTimer&&(clearTimeout(a.slowConnectionTimer),a.slowConnectionTimer=null),a.requestCancelled||n!==A){v("[Study Assist] Multi request was cancelled, ignoring response");return}if(s.classList.remove("loading","slow-connection"),a.isRequestInProgress=!1,!d||r.length===0){s.innerHTML="<span>!</span>",setTimeout(()=>{s.innerHTML="<span>SA</span>"},2e3);return}s.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(r.join(`
`))}</span>`,s.classList.add("has-answer","matching-answer"),i&&i.classList.add("matching-mode"),a.lastAnsweredQuestionNum=e[0].questionNumber??null,(t.startQuestionChangeObserver??C)(),a.hasValidAnswer=!0}async function _(e,t={detectVisibleQuestion:M,detectVisibleQuestions:de,startQuestionChangeObserver:C}){let n=document.getElementById("study-assist-quick");if(!n)return;if(a.hasValidAnswer){v("[Study Assist] Valid answer already displayed, use ALT+W to re-detect and request again");return}if(a.isRequestInProgress){v("[Study Assist] Request already in progress, ignoring");return}if(n.classList.contains("loading")){v("[Study Assist] Already loading (button state), ignoring");return}a.isRequestInProgress=!0;let s=++A;a.requestCancelled=!1,a.questionChangeInterval&&(clearInterval(a.questionChangeInterval),a.questionChangeInterval=null),a.lastAnsweredQuestionNum=null,a.slowConnectionTimer&&(clearTimeout(a.slowConnectionTimer),a.slowConnectionTimer=null);let i=document.getElementById("study-assist-quick-container");i&&i.classList.remove("matching-mode"),n.classList.remove("has-answer","multi-answer","multi-answer-large","matching-answer","slow-connection"),n.innerHTML='<span class="study-assist-quick-loading"></span>',n.classList.add("loading"),a.slowConnectionTimer=setTimeout(()=>{a.isRequestInProgress&&n.classList.contains("loading")&&(n.classList.add("slow-connection"),n.innerHTML='<span class="study-assist-slow-indicator">\u23F3</span>')},2e4);try{let r=await(t.detectVisibleQuestion??M)();if(s!==A)return;if(!r){n.innerHTML="<span>?</span>",n.classList.remove("loading"),a.isRequestInProgress=!1,setTimeout(()=>{n.innerHTML="<span>SA</span>"},1500);return}let l=await(t.detectVisibleQuestions??de)();if(s!==A)return;if(l.length>1){v("[Study Assist] Multi-question page detected:",l.length),await xt(l,t);return}let f=await Be(r);if(s!==A)return;let m=Oe(r,f,a.skipPrimary);a.skipPrimary=!1,v("[Study Assist] Sending to API:",{questionNumber:r.questionNumber,questionType:r.type,questionText:r.text?r.text.substring(0,80):"(no text)",optionsCount:r.options?r.options.length:0,options:r.options?r.options.map(u=>`${u.letter}: ${u.text?u.text.substring(0,30):""}`):[]});let g=await $e(m);if(a.slowConnectionTimer&&(clearTimeout(a.slowConnectionTimer),a.slowConnectionTimer=null),a.requestCancelled||s!==A){v("[Study Assist] Request was cancelled, ignoring response");return}if(n.classList.remove("loading","slow-connection"),a.isRequestInProgress=!1,g.success&&g.result){let u=g.result.trim(),c=document.getElementById("study-assist-quick-container");if(a.lastAnsweredQuestionNum=r.questionNumber||null,(t.startQuestionChangeObserver??C)(),r.type==="matching"){let h=u.toUpperCase().trim().replace(/,\s*/g,`
`);n.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(h)}</span>`,n.classList.add("has-answer","matching-answer"),c&&c.classList.add("matching-mode"),a.hasValidAnswer=!0}else if(r.type==="select-missing-words"){let h=u.trim().replace(/,\s*/g,`
`);n.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(h)}</span>`,n.classList.add("has-answer","matching-answer"),c&&c.classList.add("matching-mode"),a.hasValidAnswer=!0}else if(r.type==="short-answer"||r.type==="numerical"){let h=u.trim()||"?";n.innerHTML=`<span class="study-assist-quick-answer study-assist-matching-answer">${S(h)}</span>`,n.classList.add("has-answer","matching-answer"),c&&c.classList.add("matching-mode"),h!=="?"&&(a.hasValidAnswer=!0)}else{let h=u.toUpperCase();if(r.type==="true-false"){let q=He(u,r.options||[]);n.innerHTML=`<span class="study-assist-quick-answer">${q}</span>`,n.classList.add("has-answer"),q!=="?"&&(a.hasValidAnswer=!0);return}let b=h.match(/^([A-Z])\s*,\s*([A-Z])(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?(?:\s*,\s*([A-Z]))?$/),y=b?null:h.match(/^([A-Z])\s*\/\s*([A-Z])(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?(?:\s*\/\s*([A-Z]))?$/),x,w=!1,E=!1;if(b||y){let q=r.element,L=q instanceof HTMLElement&&q.querySelectorAll('input[type="radio"]').length>0,Ze=q instanceof HTMLElement&&q.querySelectorAll('input[type="checkbox"]').length>0;L&&!Ze&&(E=!0)}if(b||y){let q=b||y,L=[q[1],q[2],q[3],q[4],q[5]].filter(Boolean);E?x=L.join(" / "):x=L.join(","),w=!0}else{let q=h.match(/\b([A-Z])\b/);x=q?q[1]:"?"}n.innerHTML=`<span class="study-assist-quick-answer">${x}</span>`,n.classList.add("has-answer"),w&&(E?n.classList.add("multi-answer"):(n.classList.add("multi-answer"),x.split(",").length>=3&&n.classList.add("multi-answer-large"))),x!=="?"&&(a.hasValidAnswer=!0)}}else H&&B("quick analysis failed",{error:g.error??"Empty analysis result",questionType:r.type,questionNumber:r.questionNumber},"error"),n.innerHTML="<span>!</span>",n.classList.remove("slow-connection"),a.isRequestInProgress=!1,setTimeout(()=>{n.innerHTML="<span>SA</span>"},2e3)}catch(o){if(s!==A)return;console.error("[Study Assist] Quick analysis error:",o),H&&B("quick analysis exception",{error:o instanceof Error?o.message:"Unknown error"},"error"),a.slowConnectionTimer&&(clearTimeout(a.slowConnectionTimer),a.slowConnectionTimer=null),n.classList.remove("loading","slow-connection"),n.innerHTML="<span>!</span>",a.isRequestInProgress=!1,setTimeout(()=>{s===A&&(n.innerHTML="<span>SA</span>")},2e3)}finally{s===A&&!a.isRequestInProgress&&a.slowConnectionTimer&&(clearTimeout(a.slowConnectionTimer),a.slowConnectionTimer=null)}}function B(e,t,n="log"){try{let s=chrome.runtime.sendMessage({type:"DEV_LOG",level:n,message:e,data:t});s&&typeof s.catch=="function"&&s.catch(()=>{})}catch{}}async function ze(e,t={detectVisibleQuestion:M,startQuestionChangeObserver:C}){if(!a.isActive||!a.isDomainAllowed||a.isRequestInProgress)return;a.isRequestInProgress=!0;let n=++A;_e();try{let s=[];if(a.settings.sendImages){if(e.platform==="moodle"){if(e.images&&e.images.length>0&&(s=[...e.images]),e.options)for(let m of e.options)m.image&&s.push({...m.image,location:`option_${m.letter}`})}else if(e.element)try{s=await ie(e.element)}catch{}}let i;if(e.type==="matching"?i={questionText:e.text,questionType:"matching",matchingStyle:e.matchingStyle||"drag-drop",categories:e.categories,matchingOptions:e.matchingOptions,images:s,pageTitle:document.title,pageUrl:window.location.href,responseMode:a.settings.responseMode,courseName:e.courseName,...Q()}:e.type==="select-missing-words"?i={questionText:e.text,questionType:"select-missing-words",selectGaps:e.selectGaps,selectChoices:e.selectChoices,images:s,pageTitle:document.title,pageUrl:window.location.href,responseMode:a.settings.responseMode,courseName:e.courseName,...Q()}:e.type==="short-answer"||e.type==="numerical"?i={questionText:e.text,questionType:e.type,images:s,pageTitle:document.title,pageUrl:window.location.href,responseMode:a.settings.responseMode,courseName:e.courseName,...Q()}:i={questionText:e.text,questionType:e.type==="true-false"?"true-false":"multiple-choice",options:e.options,images:s,pageTitle:document.title,pageUrl:window.location.href,responseMode:a.settings.responseMode,courseName:e.courseName,...Q()},i.qaMode===!0&&await Re(i),n!==A)return;let o=chrome.runtime.connect({name:"stream-analysis"});V.add(o),Y("",e,t.showQuestionsSummary,!0);let r="",d=0,l=0,f=0;await new Promise((m,g)=>{let u=!1,c=y=>{u||(u=!0,clearTimeout(p),V.delete(o),O.delete(o),o.onMessage.removeListener(h),o.onDisconnect.removeListener(b),o.disconnect(),y?g(y):m())},p=setTimeout(()=>c(new Error("Stream timeout")),36e4);O.set(o,()=>c(new Error("Analysis cancelled")));let h=y=>{if(!(u||n!==A))switch(y.type){case"STREAM_CHUNK":r+=y.chunk,Y(r,e,t.showQuestionsSummary,!1);break;case"STREAM_STATUS":y.status==="input_tokens"&&(d=y.inputTokens),y.status==="complete"&&(l=y.outputTokens);break;case"STREAM_COMPLETE":d=y.inputTokens||d,l=y.outputTokens||l,f=y.cost||0,F(),Y(r,e,t.showQuestionsSummary,!1,{inputTokens:d,outputTokens:l,cost:f}),B("stream complete",{questionType:e.type,inputTokens:d,outputTokens:l,cost:f}),c();break;case"STREAM_ERROR":F(),B("stream error",{error:y.error,questionType:e.type},"error"),me(y.error||"Error de transmisi\xF3n",t.showQuestionsSummary),c(new Error(y.error));break}},b=()=>{u||c(new Error("Conexi\xF3n perdida: respuesta incompleta"))};o.onMessage.addListener(h),o.onDisconnect.addListener(b);try{o.postMessage({context:i})}catch(y){c(y)}})}catch(s){if(n!==A)return;F(),B("full analysis failed",{error:s.message},"error"),me(s.message,t.showQuestionsSummary)}finally{n===A&&(a.isRequestInProgress=!1)}}var wt={PRIMARY_RETRY:"\u26A0\uFE0F",VALIDATOR_FALLBACK:"\u{1F504}",VALIDATOR_VALIDATING:"\u{1F50D}"};function qt(e){let t=document.getElementById("study-assist-quick");if(!t)return;let n=wt[e];n&&(t.innerHTML=`<span>${n}</span>`)}async function Fe(){try{let{settings:e}=await chrome.runtime.sendMessage({type:"GET_CONTENT_SETTINGS"}),t=e.allowedDomains??be,n=window.location.hostname.toLowerCase(),s=t.some(i=>n===i||n.endsWith("."+i));return a.isDomainAllowed=s,s}catch(e){return console.error("[Study Assist] Error checking domain:",e),!1}}function Et(){if(a.contentObserver)return;let e=null;a.contentObserver=new MutationObserver(t=>{e&&clearTimeout(e),e=setTimeout(()=>{a.isActive&&a.isDomainAllowed&&a.settings.quickMode&&!document.getElementById("study-assist-quick-container")&&D()&&Tt()},500)}),a.contentObserver.observe(document.body??document.documentElement,{childList:!0,subtree:!0})}function Tt(){k({handleQuickClick:e=>_(e,{detectVisibleQuestion:M,startQuestionChangeObserver:C})})}function ee(e){return ze(e,{detectVisibleQuestion:M,startQuestionChangeObserver:C,showQuestionsSummary:R})}function R(){return Qe(M,ee)}function ge(){Le({frameHasQuizContent:D,waitForQuizContent:G,handleQuickClick:e=>_(e,{detectVisibleQuestion:M,startQuestionChangeObserver:C}),showQuestionsSummary:R})}function he(){De({triggerQuickAnalysis:()=>Pe({detectVisibleQuestion:M,startQuestionChangeObserver:C}),reloadQuickMode:()=>Ne({detectVisibleQuestion:M,startQuestionChangeObserver:C}),toggleSAButtonVisibility:ke,cancelCurrentRequest:fe})}async function ye(){if(!a.isActive||!a.isDomainAllowed)return;let e=await le();e&&e.found&&(a.settings.highlightQuestions&&K(ee),a.settings.quickMode||await R())}async function Ve(){try{let e=At(),t=e?!0:await Fe(),{settings:n}=await chrome.runtime.sendMessage({type:"GET_CONTENT_SETTINGS"});if(a.settings.responseMode=n.responseMode??"direct",a.settings.autoDetect=n.autoDetect??!0,a.settings.highlightQuestions=n.highlightQuestions??!0,a.settings.quickMode=n.quickMode??!0,a.settings.sendImages=n.sendImages??!1,a.settings.buttonPosition=n.buttonPosition??"bottom-right",a.saButtonHidden=n.saButtonHidden===!0,!t)return;if(e){let s=await chrome.tabs.getCurrent();if(!s?.id)throw new Error("Could not identify QA tab");document.documentElement.dataset.studyAssistQaTabId=String(s.id);let i=await chrome.runtime.sendMessage({type:"REGISTER_QA_TAB",tabId:s.id});if(!i?.success)throw new Error(i?.error||"QA tab registration failed")}a.isActive=!0,a.isInitialized=!0,e&&(a.isDomainAllowed=!0,a.settings.quickMode=!e.fullMode,a.settings.highlightQuestions=!0,ve(e.scenario));try{a.settings.quickMode&&he()}catch(s){console.error("[Study Assist] Keyboard init error:",s)}try{ge()}catch(s){console.error("[Study Assist] Overlay init error:",s)}e?setTimeout(()=>{St(e.fullMode)},250):a.isActive&&a.settings.autoDetect&&setTimeout(()=>ye(),1e3);try{Et()}catch(s){console.error("[Study Assist] Observer init error:",s)}}catch(e){console.error("[Study Assist] Initialization error:",e)}}function At(){let e=new URL(chrome.runtime.getURL("qa/qa.html")),t=new URL(window.location.href);if(t.origin!==e.origin||t.pathname!==e.pathname||t.hash)return null;let n=t.searchParams.get("scenario"),s=t.searchParams.get("fullMode"),i=["moodle-mcq","moodle-truefalse","moodle-match","moodle-shortanswer","moodle-numerical","moodle-gapselect","moodle-quiz","moodle-multi","netacad-mcq","netacad-matching","netacad-quiz"];return[...t.searchParams].length!==2||!n||!i.includes(n)||s!=="true"&&s!=="false"?null:{scenario:n,fullMode:s==="true"}}async function St(e){let t=await Ge();e&&await R(),v("[Study Assist] QA preview detected questions:",t)}function Mt(){let e=document.getElementById("study-assist-qa-sandbox");e&&e.remove()}function je(e,t){let n=e.shadowRoot,s=n?.querySelector(".mcq__body-inner");if(!n||!s)return;let i=Array.from(n.querySelectorAll(".mcq__item"));if(i.length===0)return;let o=`${t}-prompt`;s.id=o;let r=document.createElement("div");r.className="qa-netacad-mcq-options",r.setAttribute("role","radiogroup"),r.setAttribute("aria-labelledby",o),s.after(r),i.forEach((d,l)=>{let f=d.querySelector(".mcq__item-text-inner");if(!f)return;let m=`${t}-option-${l+1}`,g=document.createElement("input");g.type="radio",g.name=t,g.id=m,g.setAttribute("aria-labelledby",`${m}-label`);let u=document.createElement("label");u.className=f.className,u.id=`${m}-label`,u.htmlFor=m,u.textContent=f.textContent,f.replaceWith(u),d.classList.add("qa-netacad-mcq-option"),d.prepend(g),r.appendChild(d),g.addEventListener("change",()=>{for(let c of r.querySelectorAll(".qa-netacad-mcq-option"))c.classList.toggle("is-selected",c.querySelector("input[type=radio]")?.checked===!0)})})}function Ct(e){e.innerHTML=`
    <div class="qa-block">
      <h3>NetAcad Simulado \u2014 Opci\xF3n m\xFAltiple</h3>
      <p class="qa-tip">Usa <strong>SHIFT</strong> para quick mode, o clic en badge para an\xE1lisis completo.</p>
      <div class="qa-question-title">Pregunta 1</div>
      <mcq-view id="qa-netacad-mcq"></mcq-view>
    </div>
  `;let t=e.querySelector("#qa-netacad-mcq");if(!t)return;let n=t.attachShadow({mode:"open"});n.innerHTML=`
    <style>
      .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
      .mcq__item { display: flex; align-items: center; gap: 10px; margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }
      .mcq__item:hover { border-color: #bfdbfe; background: #f8fbff; }
      .mcq__item:focus-within { outline: 3px solid rgb(59 130 246 / 24%); outline-offset: 1px; }
      .mcq__item.is-selected { border-color: #60a5fa; background: #eff6ff; box-shadow: inset 0 0 0 1px rgb(59 130 246 / 8%); }
      .mcq__item-text-inner { flex: 1; font-size: 14px; color: #111827; cursor: pointer; }
      .qa-netacad-mcq-options input[type="radio"] { flex: 0 0 auto; width: 17px; height: 17px; margin: 0; accent-color: #2563eb; cursor: pointer; }
    </style>
    <div class="mcq__body-inner">\xBFCu\xE1l capa del modelo OSI se encarga del enrutamiento?</div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa F\xEDsica</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
    <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Aplicaci\xF3n</div></div>
  `,je(t,"qa-netacad-mcq")}function Lt(e){e.innerHTML=`
    <div class="qa-block">
      <h3>NetAcad Simulado \u2014 Matching</h3>
      <p class="qa-tip">En quick mode la respuesta se mostrar\xE1 como pares (ej. <strong>A-2</strong>).</p>
      <div class="qa-question-title">Pregunta 1</div>
      <object-matching-view id="qa-netacad-matching"></object-matching-view>
    </div>
  `;let t=e.querySelector("#qa-netacad-matching");if(!t)return;let n=t.attachShadow({mode:"open"});n.innerHTML=`
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
  `}function kt(e){e.innerHTML=`
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
  `}function Qt(e){e.innerHTML=`
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
  `}function _t(e){e.innerHTML=`
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
  `}function It(e){e.innerHTML=`
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
  `}function We(e){let t=Array.from(e.querySelectorAll(".qa-slide"));if(t.length===0)return;let n=0,s=e.querySelector("#qa-nav-prev"),i=e.querySelector("#qa-nav-next"),o=e.querySelector(".qa-quiz-progress");function r(){t.forEach((d,l)=>{d.style.display=l===n?"":"none"}),s&&(s.disabled=n<=0),i&&(i.disabled=n>=t.length-1),o&&(o.textContent=`Pregunta ${n+1} de ${t.length}`),window.dispatchEvent(new CustomEvent("study-assist-navigate"))}s&&s.addEventListener("click",()=>{n>0&&(n--,r())}),i&&i.addEventListener("click",()=>{n<t.length-1&&(n++,r())})}function Dt(e){e.innerHTML=`
    <div class="qa-quiz-header">
      <span class="qa-quiz-platform">\u{1F535} NetAcad \u2014 Quiz Real</span>
      <div class="qa-quiz-nav">
        <button class="qa-sandbox-nav-btn" id="qa-nav-prev" disabled>\u2190 Anterior</button>
        <span class="qa-quiz-progress">Pregunta 1 de 2</span>
        <button class="qa-sandbox-nav-btn" id="qa-nav-next">Siguiente \u2192</button>
      </div>
    </div>
    <div class="qa-slide" data-slide="0">
      <div class="qa-block">
        <h3>Opci\xF3n m\xFAltiple (MCQ)</h3>
        <mcq-view id="qa-netacad-quiz-mcq"></mcq-view>
      </div>
    </div>

    <div class="qa-slide" data-slide="1" style="display:none">
      <div class="qa-block">
        <h3>Relacionar (Matching)</h3>
        <p class="qa-tip">En quick mode la respuesta se mostrar\xE1 como pares (ej. <strong>A-2</strong>).</p>
        <object-matching-view id="qa-netacad-quiz-matching"></object-matching-view>
      </div>
    </div>
  `;let t=e.querySelector("#qa-netacad-quiz-mcq");if(t){let s=t.attachShadow({mode:"open"});s.innerHTML=`
      <style>
        .mcq__body-inner { font-size: 16px; margin-bottom: 12px; color: #1f2937; }
        .mcq__item { display: flex; align-items: center; gap: 10px; margin: 8px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }
        .mcq__item:hover { border-color: #bfdbfe; background: #f8fbff; }
        .mcq__item:focus-within { outline: 3px solid rgb(59 130 246 / 24%); outline-offset: 1px; }
        .mcq__item.is-selected { border-color: #60a5fa; background: #eff6ff; box-shadow: inset 0 0 0 1px rgb(59 130 246 / 8%); }
        .mcq__item-text-inner { flex: 1; font-size: 14px; color: #111827; cursor: pointer; }
        .qa-netacad-mcq-options input[type="radio"] { flex: 0 0 auto; width: 17px; height: 17px; margin: 0; accent-color: #2563eb; cursor: pointer; }
      </style>
      <div class="mcq__body-inner">\xBFCu\xE1l capa del modelo OSI se encarga del enrutamiento l\xF3gico de paquetes?</div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa F\xEDsica</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Enlace de Datos</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Red</div></div>
      <div class="mcq__item"><div class="mcq__item-text-inner">Capa de Transporte</div></div>
    `,je(t,"qa-netacad-quiz-mcq")}let n=e.querySelector("#qa-netacad-quiz-matching");if(n){let s=n.attachShadow({mode:"open"});s.innerHTML=`
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
    `}We(e)}function Ue(e){e.innerHTML=`
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
  `}function Rt(e){Array.from(e.querySelectorAll(".que.multichoice")).forEach((n,s)=>{let i=n.querySelector(".qtext"),o=n.querySelector(".answer");if(!o)return;let r=`qa-moodle-mcq-prompt-${s+1}`;i&&!i.id&&(i.id=r),o.setAttribute("role","radiogroup"),i?.id&&o.setAttribute("aria-labelledby",i.id),Array.from(o.querySelectorAll(":scope > div.r0, :scope > div.r1")).forEach((l,f)=>{let m=l.querySelector(".flex-fill");if(!m)return;let g=l.querySelector(".answernumber")?.textContent?.trim().replace(/\.$/,"")||String.fromCharCode(97+f),u=`qa-moodle-mcq-${s+1}-${f+1}`,c=document.createElement("input");c.type="radio",c.name=`qa-moodle-mcq-${s+1}`,c.id=u,c.value=g.toUpperCase(),c.className="qa-moodle-mcq-radio",c.setAttribute("aria-label",`${g}. ${m.textContent?.trim()||""}`);let p=document.createElement("label");for(p.htmlFor=u,p.className=m.className;m.firstChild;)p.appendChild(m.firstChild);m.replaceWith(p),l.classList.add("qa-moodle-mcq-option"),l.insertBefore(c,p),c.addEventListener("change",()=>{o.querySelectorAll(`input[name="${c.name}"]`).forEach(h=>{h.closest(".qa-moodle-mcq-option")?.classList.toggle("is-selected",h.checked)})})})})}function Ht(e){e.innerHTML=`
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
  `,We(e)}function ve(e){let t="study-assist-qa-sandbox-style",n=document.getElementById(t);n||(n=document.createElement("style"),n.id=t,document.head.appendChild(n)),n.textContent=`
      /* Keep test controls opaque if scenario markup adds opacity styles. */
      #study-assist-qa-sandbox,
      #study-assist-qa-sandbox div { opacity: 1; }
      #study-assist-qa-sandbox {
        position: relative;
        z-index: 9997;
        margin: 18px 0;
        padding: 16px;
        border: 1px solid #dbe4f0;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
        font-family: Arial, sans-serif;
      }
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
    `;let s=document.createElement("section");s.id="study-assist-qa-sandbox",document.querySelector(".qa-loading")?.remove(),s.innerHTML=a.settings.quickMode?'<p class="qa-meta">SHIFT para analizar \xB7 ALT+W para re-detectar.</p>':"";let i=document.createElement("div");s.appendChild(i),e==="moodle-mcq"?i.innerHTML=`
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
    `:e==="moodle-shortanswer"?kt(i):e==="moodle-numerical"?Qt(i):e==="moodle-gapselect"?_t(i):e==="netacad-mcq"?Ct(i):e==="moodle-match"?It(i):e==="netacad-quiz"?Dt(i):e==="moodle-quiz"?Ht(i):e==="moodle-multi"?Ue(i):Lt(i),["moodle-mcq","moodle-quiz","moodle-multi"].includes(e)&&Rt(i),(document.getElementById("qa-root")??document.body).appendChild(s)}async function Ge(){let e=await le();return e?.found&&K(ee),e?.count??0}chrome.runtime.onMessage.addListener((e,t,n)=>{switch(e.type){case"DOMAIN_SETTINGS_CHANGED":return(async()=>(await Fe()?a.isActive||await Ve():(a.isActive=!1,fe(),a.contentObserver?.disconnect(),a.contentObserver=null,a.questionChangeInterval&&clearInterval(a.questionChangeInterval),a.questionChangeInterval=null,P(),z(),document.getElementById("study-assist-quick-container")?.remove()),n({success:!0})))(),!0;case"SETTINGS_CHANGED":if(!a.isDomainAllowed){n({success:!1,error:"Domain not allowed"});break}let s=a.settings.quickMode;a.settings={...a.settings,...e.settings},s!==a.settings.quickMode&&(a.settings.quickMode&&he(),ge()),a.settings.highlightQuestions&&a.isActive?K(ee):P(),n({success:!0});break;case"ANALYZE_PAGE":if(!a.isDomainAllowed){n({success:!1,error:"Domain not allowed"});break}a.isActive&&(async()=>(await ye(),await R()))(),n({success:!0});break;case"CLEAR_RESULTS":P(),z(),a.detectedQuestions=[],n({success:!0});break;case"FORCE_STATE_RESET":a.isRequestInProgress=!1,a.hasValidAnswer=!1,a.skipPrimary=!1,a.requestCancelled=!1,a.pendingQuestionChange=null,a.slowConnectionTimer&&(clearTimeout(a.slowConnectionTimer),a.slowConnectionTimer=null),v("[Study Assist] Force state reset complete"),n({success:!0});break;case"ANALYSIS_RESULT":e.result&&e.question&&Ie(e.result,e.question,R),n({success:!0});break;case"QA_INJECT_SCENARIO":return(async()=>{try{let i=e.scenario??"moodle-truefalse",o=e.fullMode===!0;a.isDomainAllowed=!0,a.isActive=!0,a.settings.quickMode=!o,a.settings.highlightQuestions=!0,ve(i),he(),ge();let r=await Ge();o&&await R(),v("[Study Assist] QA preview detected questions:",r),n({success:!0})}catch(i){n({success:!1,error:i.message})}})(),!0;case"QA_CLEAR_SCENARIO":Mt(),P(),z(),X(),a.detectedQuestions=[],n({success:!0});break}return!0});window.addEventListener("study-assist-navigate",()=>{a.isActive&&a.isDomainAllowed&&ye()});Ve();var xn={injectMoodleMulti:Ue,injectQAScenario:ve};})();
