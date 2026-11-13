import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {renderCustomerSummaryHtml,renderOperatorStatusHtml} from '../dist/reports/summary.js';
const evidence=(audit,path,extra={})=>({pageUrl:`https://fixture.example${path}`,source:'http',observedAt:audit.startedAt,...extra});

test('customer reports exclude administrative indexing and login-link errors while preserving raw evidence',()=>{
 const {audit}=createEvidenceFixture(1);
 audit.coverage.urls.push({url:'https://fixture.example/lessons/',outcome:'captured',statusCode:200});
 audit.findings=[
  {code:'noindex',category:'indexability',observed:'Admin login is noindex',evidence:[evidence(audit,'/wp-login.php?redirect_to=%2Fcourse')]},
  {code:'missing_meta_description',category:'metadata',observed:'Admin has no description',evidence:[evidence(audit,'/wp-admin/')]},
  {code:'http_status_error',category:'indexability',observed:'Admin error',evidence:[evidence(audit,'/wp-login.php?action=lostpassword',{value:404})]},
  {code:'broken_internal_link',category:'indexability',observed:'Login link error',evidence:[evidence(audit,'/page-000',{value:404,anchorHref:'https://fixture.example/wp-login.php?redirect_to=%2Fpage-000',requestedUrl:'https://fixture.example/wp-login.php?redirect_to=%2Fpage-000'})]},
  {code:'missing_h1',category:'content',observed:'Public page has no H1',evidence:[evidence(audit,'/lessons/')]},
 ];
 const before=JSON.stringify(audit);
 const customer=renderCustomerSummaryHtml(audit,'en');
 for(const code of ['noindex','missing_meta_description','http_status_error','broken_internal_link'])assert.ok(!customer.includes(`data-issue-code="${code}"`),code);
 assert.match(customer,/data-issue-code="missing_h1"/u);
 assert.match(renderOperatorStatusHtml(audit,'en'),/Admin login is noindex/u);
 assert.equal(JSON.stringify(audit),before);
});

test('mixed findings retain public evidence and do not blanket-exclude customer login pages',()=>{
 const {audit}=createEvidenceFixture(1);
 audit.coverage.urls.push({url:'https://fixture.example/lessons/',outcome:'captured',statusCode:200});
 audit.findings=[{code:'missing_h1',category:'content',observed:'Missing heading',evidence:[evidence(audit,'/wp-login.php'),evidence(audit,'/lessons/')]}];
 const html=renderCustomerSummaryHtml(audit,'en');
 assert.match(html,/data-issue-code="missing_h1" data-example-finding="0" data-example-evidence="1"/u);
 assert.match(html,/1 page to review/u);
 audit.coverage.urls.push({url:'https://fixture.example/account/login',outcome:'captured',statusCode:200});
 audit.findings=[{code:'noindex',category:'indexability',observed:'Customer login is noindex',evidence:[evidence(audit,'/account/login')]}];
 assert.match(renderCustomerSummaryHtml(audit,'en'),/data-issue-code="noindex"/u);
});

test('customer examples prefer a top-level offer over nested attachment URLs',()=>{
 const {audit}=createEvidenceFixture(1);
 for(const path of ['/advanced-lessons/attachment/1/','/surfing-lessons/']) audit.coverage.urls.push({url:`https://fixture.example${path}`,outcome:'captured',statusCode:200});
 audit.findings=[{code:'missing_h1',category:'content',observed:'Missing heading',evidence:[evidence(audit,'/advanced-lessons/attachment/1/'),evidence(audit,'/surfing-lessons/')]}];
 assert.match(renderCustomerSummaryHtml(audit,'en'),/data-example-evidence="1"/u);
});

test('one missing resource is not presented as two customer issues',()=>{
 const {audit}=createEvidenceFixture(1);
 audit.findings=[
  {code:'broken_internal_link',category:'indexability',observed:'Missing file',evidence:[evidence(audit,'/page-000',{value:404,anchorHref:'https://fixture.example/missing.jpg',requestedUrl:'https://fixture.example/missing.jpg'})]},
  {code:'http_status_error',category:'indexability',observed:'File HTTP 404',evidence:[evidence(audit,'/missing.jpg',{value:404})]},
 ];
 audit.coverage.urls.push({url:'https://fixture.example/missing.jpg',outcome:'captured',statusCode:404},{url:'https://fixture.example/different-error',outcome:'captured',statusCode:503});
 audit.findings[0].evidence.push(evidence(audit,'/missing.jpg',{value:404,requestedUrl:'https://fixture.example/missing.jpg'}));
 const html=renderCustomerSummaryHtml(audit,'en');
 assert.match(html,/data-issue-code="broken_internal_link"/u);
 assert.doesNotMatch(html,/data-issue-code="http_status_error"/u);
 audit.findings[1].evidence.push(evidence(audit,'/different-error',{value:503}));
 assert.match(renderCustomerSummaryHtml(audit,'en'),/data-issue-code="http_status_error"/u);
});
