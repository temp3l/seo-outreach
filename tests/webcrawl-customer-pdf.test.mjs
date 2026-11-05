import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {renderCustomerSummaryHtml,renderCustomerSummaryPdf,renderOperatorStatusPdf} from '../dist/reports/summary.js';
import {playwrightPdfRenderer} from '../dist/reports/pdf-playwright.js';
import {chromium} from 'playwright';

test('actual one-page A4 EN/DE customer PDFs show readable linked page labels and include issuer contact',async()=>{
  const {audit}=createEvidenceFixture(3);
  const issuer={name:'Synthetic Reviewer',company:'Example Review Studio',email:'reviewer@example.test',phone:'+49 30 12345678',website:'https://example.test/'};
  const observedAt=audit.startedAt;
  audit.findings=[
    {code:'noindex',category:'indexability',observed:'Observed noindex',evidence:['/kurse?token=PRIVATE_QUERY','/impressum'].map(path=>({pageUrl:'https://fixture.example'+path,source:'http',observedAt}))},
    {code:'missing_h1',category:'content',severity:'critical',observed:'Missing main heading',evidence:[{pageUrl:'https://fixture.example/kurse/beginner',source:'http',observedAt}]},
    {code:'pagespeed_category_score',category:'performance',observed:'performance score: 39/100.',evidence:[{pageUrl:'https://fixture.example/',source:'pagespeed',value:39,observedAt}]},
    {code:'missing_nosniff_header',category:'security',severity:'low',observed:'Header absent',evidence:[{pageUrl:'https://fixture.example/kurse',source:'http',observedAt}]},
  ];
  for (const code of ['http_status_error', 'missing_meta_description', 'title_long']) audit.findings.push({code,category:'metadata',observed:code,evidence:[{pageUrl:'https://fixture.example/',source:'http',observedAt,value:404}]});
  for (const url of [audit.target,'https://fixture.example/kurse?token=PRIVATE_QUERY','https://fixture.example/impressum','https://fixture.example/kurse/beginner']) audit.coverage.urls.push({url,outcome:'captured',statusCode:200});
  audit.contacts={candidates:[{normalizedValue:'SITE_CONTACT_DO_NOT_SUBSTITUTE'}]};
  const root=await mkdtemp('/tmp/webcrawl-customer-pdf-');
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    for(const locale of ['en','de']){
      const options={locale,issuer,clientReady:true};
      assert.equal((renderCustomerSummaryHtml(audit,locale,options).match(/<article class="card">/g)??[]).length,3);
      const file=`${root}/${locale}.pdf`;
      await writeFile(file,await renderCustomerSummaryPdf(audit,playwrightPdfRenderer,options),{mode:0o600});
      const text=execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'});
      assert.match(text,/Synthetic Reviewer/u);assert.match(text,/reviewer@example.test/u);assert.match(text,/\+49 30 12345678/u);
      const contactLine=text.split('\n').find(line=>line.includes(issuer.email));
      assert.ok(contactLine?.includes(issuer.name) && contactLine.includes(issuer.company) && contactLine.includes(issuer.phone),`${locale}: contact should fit one line`);
      const urls=execFileSync('pdfinfo',['-url',file],{encoding:'utf8'});
      assert.match(urls,/https:\/\/fixture\.example\/kurse\/beginner/u);
      assert.match(text,/Example page|Beispielseite/u);
      assert.doesNotMatch(text,/https:\/\/fixture\.example\/kurse\/beginner/u);
      assert.match(urls,/https:\/\/fixture\.example\/kurse\/beginner/u);
      assert.doesNotMatch(urls,/PRIVATE_QUERY|token=/u);
      assert.doesNotMatch(text,/PRIVATE_QUERY|token=/u);
      assert.doesNotMatch(text,/https:\/\/example\.test/u);
      assert.match(text,locale==='de'?/Startseite/u:/Homepage/u);
      assert.doesNotMatch(text,/Choose a priority and next step|Wählen Sie einen Schwerpunkt|Measured:|Gemessen:|site-wide field Core Web Vitals/u);
      assert.doesNotMatch(text,/HOLD/u);
      assert.match(renderCustomerSummaryHtml(audit,locale,{...options,clientReady:false}),/data-publication-status="HOLD"/u);
      assert.match(text,locale==='de'?/Kontaktieren Sie uns über die unten stehenden Angaben/u:/Contact us using the reply details below/u);
      assert.doesNotMatch(text,/SITE_CONTACT_DO_NOT_SUBSTITUTE|PRIVATE_QUERY|0 recommended tasks|0 empfohlene Aufgaben|Example to check|Beispiel zum Prüfen|Requested:|Angefragt:|Coverage limitations|Grenzen der Prüfung|Internal draft|Interner Entwurf/u);
      assert.match(execFileSync('pdfinfo',[file],{encoding:'utf8'}),/594(?:\.96)? x 841.92/u);
      await page.setContent(renderCustomerSummaryHtml(audit,locale,options));
      await page.emulateMedia({media:'print'});
      const geometry=await page.evaluate(()=>[...document.querySelectorAll('.page')].map(p=>{const page=p.getBoundingClientRect(),footer=p.querySelector('footer').getBoundingClientRect();return {height:page.height,footerBottom:footer.bottom,pageBottom:page.bottom,footerLeft:footer.left-page.left,footerRight:page.right-footer.right};}));
      assert.ok(geometry.every(p=>p.height<=297*96/25.4+1 && p.footerBottom<=p.pageBottom && p.footerLeft>0 && p.footerRight>0),JSON.stringify({locale,geometry}));
      const spacing = await page.evaluate(() => {
        const row = document.querySelector('.snapshots');
        const boxes = [...row.children].map(e => e.getBoundingClientRect());
        const grid = document.querySelector('.grid');
        const cards = [...grid.children].map(e => e.getBoundingClientRect());
        const bounds = row.getBoundingClientRect();
        return { leftGap: boxes[0].left - bounds.left, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, rowGap: cards[2].top - cards[0].bottom };
      });
      assert.ok(spacing.leftGap >= 0, `${locale}: summary badges stay within the content area`);
      assert.equal(spacing.columns, 1);
      assert.ok(spacing.rowGap >= 3 * 96 / 25.4 - 1, `${locale}: issue rows need readable vertical spacing`);
      const branding = await page.evaluate(() => {
        const footer = document.querySelector('footer.issuer');
        const offer = document.querySelector('.offer');
        const style = getComputedStyle(footer);
        const page=document.querySelector('.page').getBoundingClientRect(),box=footer.getBoundingClientRect();
        return { header: getComputedStyle(document.querySelector('.hero')).backgroundColor, footerPadding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], footerLeft:box.left-page.left,footerRight:page.right-box.right, offerGap: offer.getBoundingClientRect().top - document.querySelector('.findings').getBoundingClientRect().bottom };
      });
      assert.equal(branding.header, 'rgb(16, 45, 58)');
      assert.ok(branding.footerLeft > 0 && branding.footerRight > 0);
      assert.ok(branding.offerGap < 5 * 96 / 25.4, `${locale}: closing should follow the findings without a large blank gap`);
      const smallest=await page.evaluate(()=>Math.min(...[...document.querySelectorAll('.card p,.offer p,.issuer,.score-date')].map(e=>parseFloat(getComputedStyle(e).fontSize))));
      assert.ok(smallest>=12,`${locale}: essential text must remain at least 9pt, got ${smallest}px`);
      const physicalPages=text.split('\f').filter(s=>s.trim());
      assert.equal(physicalPages.length,1,`${locale}: no orphan continuation pages`);
      assert.ok(physicalPages.every(s=>s.includes(issuer.email)),'issuer on every physical page');
      assert.equal((await readFile(file)).subarray(0,4).toString(),'%PDF');
    }
  }finally{await browser.close();}
});

test('actual customer PDFs show the SEO gauge only below 60', async () => {
  const { audit } = createEvidenceFixture(1);
  const root = await mkdtemp('/tmp/webcrawl-seo-gauge-');
  try {
    for (const locale of ['en', 'de']) for (const value of [59, 60, 100]) {
      audit.findings = [{ code: 'pagespeed_category_score', category: 'performance', observed: `seo score: ${value}/100.`, evidence: [{ pageUrl: audit.target, observedAt: audit.startedAt, source: 'pagespeed', value }] }];
      const file = `${root}/${locale}-${value}.pdf`;
      await writeFile(file, await renderCustomerSummaryPdf(audit, playwrightPdfRenderer, { locale }));
      const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
      assert.equal(text.split('\f').filter(page => page.trim()).length, 1);
      assert.equal(new RegExp(`\\b${value}\\b`, 'u').test(text), value < 60, `${locale}: SEO ${value}`);
      assert.equal(/SEO/u.test(text), value < 60, `${locale}: hide the entire SEO result at 60 and above`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pathological issuer remains HOLD while retaining the three-topic cap', () => {
  const {audit}=createEvidenceFixture(3);
  audit.findings=['missing_canonical','missing_meta_description','title_long','images_missing_alt','missing_h1','heading_hierarchy_skip'].map(code=>({code,category:'content',observed:code,evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.startedAt}]}));
  audit.coverage.urls.push({url:audit.target,outcome:'captured',statusCode:200});
  const issuer={name:'W'.repeat(100),company:'W'.repeat(100),email:'reviewer@example.test',phone:'+49 30 12345678'};
  for(const locale of ['en','de']) {
    assert.equal((renderCustomerSummaryHtml(audit,locale,{issuer}).match(/<article class="card">/g)??[]).length,3);
    assert.match(renderCustomerSummaryHtml(audit,locale,{issuer,clientReady:true}),/data-publication-status="HOLD"/u);
  }
});

test('customer topics omit metadata evidence from captured 404 and 410 pages', () => {
  const {audit}=createEvidenceFixture(3);
  const observedAt=audit.startedAt;
  audit.coverage={urls:[
    {url:'https://fixture.example/',outcome:'captured',statusCode:200},
    {url:'https://fixture.example/old-offer',outcome:'captured',statusCode:404},
  ]};
  audit.findings=[{code:'missing_meta_description',category:'metadata',observed:'Missing description',evidence:[
    {pageUrl:'https://fixture.example/',observedAt,source:'http'},
    {pageUrl:'https://fixture.example/old-offer',observedAt,source:'http'},
  ]}];
  const html=renderCustomerSummaryHtml(audit,'en');
  assert.match(html,/https:\/\/fixture\.example\//u);
  assert.doesNotMatch(html,/old-offer/u);
});

test('operator PDF keeps readable text within physical page margins', async () => {
  const { audit } = createEvidenceFixture(3);
  audit.findings = Array.from({ length: 40 }, (_, index) => ({ code: `synthetic_${index}`, category: 'security', observed: `Observation ${index}`, evidence: [{ pageUrl: `https://fixture.example/page-${index}`, observedAt: audit.startedAt, source: 'http' }] }));
  const root = await mkdtemp('/tmp/webcrawl-operator-pages-');
  try {
    const file = `${root}/operator.pdf`;
    await writeFile(file, await renderOperatorStatusPdf(audit, playwrightPdfRenderer, { locale: 'en' }));
    const bbox = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
    const pages = [...bbox.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/gu)].map(match => match[1]);
    assert.ok(pages.length > 1);
    for (const page of pages) {
      const words = [...page.matchAll(/yMin="([\d.]+)"[^>]*yMax="([\d.]+)"/gu)].map(match => [Number(match[1]), Number(match[2])]);
      assert.ok(words.length > 0);
      assert.ok(words.every(([top, bottom]) => top > 12 && bottom < 830), JSON.stringify(words));
    }
    assert.match(bbox, /Observation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one to three topics stay qualified internal HOLD previews with inset EN/DE footers', async () => {
  const {audit}=createEvidenceFixture(3);
  audit.coverage.urls.push({url:audit.target,outcome:'captured',statusCode:200});
  const codes=['missing_canonical','missing_meta_description','images_missing_alt','missing_h1','heading_hierarchy_skip','title_long'];
  const issuer={name:'Synthetic Reviewer',email:'reviewer@example.test'};
  const root=await mkdtemp('/tmp/webcrawl-four-six-pdf-');
  const browser=await chromium.launch({headless:true});
  try {
    for(const count of [0,1,2,3,4,5,6]) for(const locale of ['en','de']) {
      audit.findings=codes.slice(0,count).map(code=>({code,category:'content',observed:code,evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.startedAt}]}));
      const options={locale,issuer,clientReady:count>=4};
      assert.equal((renderCustomerSummaryHtml(audit,locale,options).match(/<article class="card">/g)??[]).length,Math.min(count,3));
      const file=`${root}/${locale}-${count}.pdf`;
      await writeFile(file,await renderCustomerSummaryPdf(audit,playwrightPdfRenderer,options));
      const text=execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'});
      assert.equal(text.split('\f').filter(page=>page.trim()).length,1);
      assert.match(text,/reviewer@example.test/);
      assert.doesNotMatch(text,/HOLD|NICHT ZUR KUNDENWEITERGABE|NOT FOR CUSTOMER DISTRIBUTION/);
      assert.match(renderCustomerSummaryHtml(audit,locale,{...options,clientReady:false}),/data-publication-status="HOLD"/);
      assert.doesNotMatch(text,/429/);
      if (count) assert.match(text,/Example page|Beispielseite/);
      const page=await browser.newPage();
      try {
        await page.setContent(renderCustomerSummaryHtml(audit,locale,options));
        await page.emulateMedia({media:'print'});
        const layout=await page.evaluate(()=>{
          const sheet=document.querySelector('.page').getBoundingClientRect();
          const footer=document.querySelector('footer').getBoundingClientRect();
          const offer=document.querySelector('.offer').getBoundingClientRect();
          const findings=document.querySelector('.findings').getBoundingClientRect();
          return {height:sheet.height,footerGap:sheet.bottom-footer.bottom,overlap:offer.bottom>footer.top,invitationGap:offer.top-findings.bottom};
        });
        assert.ok(Math.abs(layout.height-297*96/25.4)<1,JSON.stringify({locale,count,layout}));
        assert.ok(layout.footerGap>0,JSON.stringify({locale,count,layout}));
        assert.equal(layout.overlap,false);
        assert.ok(layout.invitationGap<5*96/25.4,'invitation stays near findings while footer sits at page bottom');
      } finally {await page.close();}
    }
  } finally {await browser.close();await rm(root,{recursive:true,force:true});}
});
