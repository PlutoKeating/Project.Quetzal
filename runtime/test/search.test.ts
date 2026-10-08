// 网页搜索：结果页解析（按真实页面结构构造的样例）、跳转链接解码、引擎选择与兜底。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBing, parseBaidu, parseSo, bingTarget, ORDER, webSearch } from "../src/mind/search.ts";

const bingPage = `<ol id="b_results">
<li class="b_algo" data-id iid=SERP.5335><link rel="stylesheet" href="/rp/x.css"/><div class="b_tpcn"><a class="tilk" href="https://www.sohu.com/a/1"><div class="tptt">sohu.com</div><cite>https://www.sohu.com</cite></a></div>
<h2 class=""><a target="_blank" href="https://www.sohu.com/a/1" h="ID=SERP,1"><strong>忒修斯之船悖论</strong>：身份和形而上学的难题</a></h2>
<div class="b_caption"><p class="b_lineclamp2">2024年8月12日&ensp;&#0183;&ensp;忒修斯之船是哲学中最著名的思想实验 &amp; 难题 …</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvU2hpcF9vZl9UaGVzZXVz&amp;ntb=1">Ship of Theseus - Wikipedia</a></h2><p>The ship of Theseus is a thought experiment.</p></li>
<li class="b_ad"><h2><a href="https://ads.example.com">广告</a></h2></li>
</ol>`;

const baiduPage = `<div id="content_left">
<div class="result c-container xpath-log new-pmd" srcid="1599" id="1" tpl="www_index" mu="https://baijiahao.baidu.com/s?id=1&amp;wfr=spider" nr="1"><div class="cosc-card"><h3 class="cosc-title t"><a href="http://www.baidu.com/link?url=AAA" target="_blank"><span><!--s-text-->长生不老真能实现?一个流传千年的<em>悖论</em><!--/s-text--></span></a></h3><div class="summary"><span>忒修斯之船是一个古老的思想实验，讨论替换全部部件后是否仍是原物。</span></div></div></div>
<div class="result-op c-container" tpl="sp_realtime"><h3><a href="http://www.baidu.com/link?url=BBB">实时新闻</a></h3><div>今天的相关报道</div></div>
</div>`;

test("必应：标题、真实链接、摘要，跳过广告", () => {
  const r = parseBing(bingPage);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { title: "忒修斯之船悖论：身份和形而上学的难题", url: "https://www.sohu.com/a/1", snippet: "2024年8月12日 · 忒修斯之船是哲学中最著名的思想实验 & 难题 …" });
  assert.equal(r[1].url, "https://en.wikipedia.org/wiki/Ship_of_Theseus"); // 跳转链接已解码
  assert.equal(r[1].snippet, "The ship of Theseus is a thought experiment.");
});

test("百度：优先取 mu 真实地址，没有时用跳转链接；摘要不含标题", () => {
  const r = parseBaidu(baiduPage);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "长生不老真能实现?一个流传千年的悖论");
  assert.equal(r[0].url, "https://baijiahao.baidu.com/s?id=1&wfr=spider");
  assert.match(r[0].snippet, /^忒修斯之船是一个古老的思想实验/);
  assert.equal(r[1].url, "http://www.baidu.com/link?url=BBB");
});

const soPage = `<ul class="result">
<li class="res-list" data-lazyload="1"><h3 class="res-title "><a href="https://baike.so.com/doc/5349027.html" data-ver="strong" target="_blank"><em>李清照</em>(宋代女<em>词人</em>)_360百科</a></h3><div class="res-rich"><p class="res-desc"><span class="res-list-summary"><em>李清照</em>（1084年—1155年），号易安居士&nbsp;…</span> <a class="detail">详情&gt;&gt;</a></p></div></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=xyz" data-mdurl="https://www.360kuai.com/pc/1" target="_blank">才女、<em>词</em>魂</a></h3><div><span class="res-list-summary">在中国悠久的历史长河中…</span></div></li>
</ul>`;

test("360 搜索：优先取 data-mdurl 真实地址", () => {
  const r = parseSo(soPage);
  assert.deepEqual(r[0], { title: "李清照(宋代女词人)_360百科", url: "https://baike.so.com/doc/5349027.html", snippet: "李清照（1084年—1155年），号易安居士 …" });
  assert.equal(r[1].url, "https://www.360kuai.com/pc/1");
});

test("跳转链接解码与引擎选择", () => {
  assert.equal(bingTarget("https://example.com/x"), "https://example.com/x");
  assert.deepEqual(ORDER, ["so", "baidu", "bing-cn"], "固定顺序，不按查询文字猜语言");
});

const fake = (pages: Record<string, string | number>) => (async (url: string, init: any) => {
  assert.match(init.headers["user-agent"], /Chrome\/\d+/); // 必须是真实浏览器请求头
  const host = new URL(url).hostname;
  const v = pages[host] ?? 500;
  return typeof v === "number" ? new Response("", { status: v }) : new Response(v, { status: 200 });
}) as unknown as typeof fetch;

test("360 没有结果时退到百度，并说明来源", async () => {
  const out = await webSearch("忒修斯之船", { fetcher: fake({ "www.so.com": "<html></html>", "www.baidu.com": baiduPage }) });
  assert.match(out, /^【百度】「忒修斯之船」前 2 条/);
  assert.match(out, /1\. 长生不老真能实现/);
});

test("条数限制与全部失败时的说明", async () => {
  const out = await webSearch("忒修斯之船", { count: 1, fetcher: fake({ "www.so.com": 502, "cn.bing.com": bingPage }) });
  assert.match(out, /^【必应】「忒修斯之船」前 1 条/);
  assert.doesNotMatch(out, /Wikipedia/);
  const none = await webSearch("忒修斯之船", { fetcher: fake({ "www.so.com": "<html></html>", "cn.bing.com": 403, "www.baidu.com": "<html></html>" }) });
  assert.match(none, /没有找到结果。已尝试：360 搜索（没有结果）、百度（没有结果）、必应（HTTP 403）/);
});

test("没有结果时照实说明：被转到别的网站（验证页）就写出转到了哪里；结果相不相关不替她判断", async () => {
  const redirect = (async (url: string) => {
    const host = new URL(url).hostname;
    if (host === "www.so.com") { const r = new Response("<html></html>", { status: 200 }); Object.defineProperty(r, "url", { value: "https://qcaptcha.so.com/?ret=x" }); return r; }
    if (host === "www.baidu.com") return new Response("<html></html>", { status: 200 });
    return new Response(`<li class="b_algo"><h2><a href="https://baike.baidu.com/item/li">李（汉语汉字）_百度百科</a></h2><p>李，汉语常用字</p></li>`, { status: 200 });
  }) as unknown as typeof fetch;
  const out = await webSearch("李清照 词 人生 经历", { fetcher: redirect });
  assert.match(out, /^【必应】「李清照 词 人生 经历」前 1 条（需要全文/, "拿到结果即返回，不按关键词重叠丢弃");
  const none = await webSearch("忒修斯之船", { engine: "so", fetcher: redirect });
  assert.match(none, /360 搜索（没有结果，被转到了 qcaptcha\.so\.com）/);
});
