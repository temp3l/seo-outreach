import test from 'node:test';
import assert from 'node:assert/strict';
import { projectContactEvidence } from '../dist/contact-evidence.js';

const source = (extra={}) => ({pageUrl:'https://school.example/contato/?utm_source=x',type:'whatsapp-link',region:'contact-section',contactPage:true,observedAt:'2026-10-31T20:35:24.460Z',captureMode:'http',channel:'whatsapp',whatsappEvidenceKind:'VALID_DIRECT_WHATSAPP_LINK',whatsappLinkState:'VALID_DIRECT_WHATSAPP_LINK',locator:'#whatsapp',context:'contact widget',elementLabel:'WhatsApp',branchLabel:'Cumbuco',...extra});
const candidate = (extra={}) => ({kind:'phone',normalizedValue:'+5585992870262',e164:'+5585992870262',rawValue:['+55 (85) 99287-0262 ','+5585992870262'],sources:[source()],channels:['phone','whatsapp'],whatsappLinkState:'VALID_DIRECT_WHATSAPP_LINK',rank:{tier:2,reasons:['dedicated_contact_page','whatsapp_channel_observed']},validation:'FORMAT_VALID',ownership:'UNVERIFIED',eligibleForPrimary:true,...extra});
const inventory = (extra={}) => ({profile:'contacts-v12-whatsapp-source-review',status:'partial',coverage:{capturedHtmlPages:10,inspectedPages:9,pagesWithNoCandidates:2,uninspectedPages:1,knownContactPagesUncaptured:['https://school.example/contact'],knownContactPagesOmitted:0,incompleteDiscoveryPages:1,acceptedEmails:1,acceptedPhones:1,rejectedValues:4,mergedOccurrences:3,retainedSources:1,omittedCandidates:2,untrackedCandidateOverflowOccurrences:0,omittedSources:5,omittedRawVariants:1,truncatedHtmlPages:0,omittedPageCandidates:0,omittedTraversalNodes:0,omittedJsonLdValues:0,omittedVisibleText:0,unresolvedWhatsAppLinks:1,omittedWhatsAppLinks:0},candidates:[candidate()],unresolvedWhatsApp:[source({type:'static-widget',whatsappEvidenceKind:'BUTTON_OBSERVED_NUMBER_UNRESOLVED',whatsappLinkState:undefined})],suggestedPrimary:{email:null,phone:null},...extra});

test('retains bounded Webcrawl rank, coverage, suggestions, and contact provenance with HOLD eligibility',()=>{
  const x=projectContactEvidence(inventory());
  assert.equal(x.profile,'contacts-v12-whatsapp-source-review'); assert.equal(x.status,'partial'); assert.equal(x.eligibility,'HOLD');
  assert.equal(x.candidates[0].rank.tier,2); assert.deepEqual(x.candidates[0].rank.reasons,['dedicated_contact_page','whatsapp_channel_observed']);
  assert.equal(x.candidates[0].e164,'+5585992870262'); assert.deepEqual(x.candidates[0].rawValue,['+55 (85) 99287-0262 ','+5585992870262']);
  assert.equal(x.candidates[0].upstreamEligibleForPrimary,true); assert.equal(x.candidates[0].whatsappLinkState,'VALID_DIRECT_WHATSAPP_LINK');
  assert.deepEqual(x.suggestedPrimary,{email:{known:true,value:null},phone:{known:true,value:null}});
  assert.equal(x.knownContactPagesUncaptured,1); assert.equal(x.coverage.omittedSources,5); assert.equal(x.coverage.unresolvedWhatsAppLinks,1); assert.equal(x.candidatesOmitted,0); assert.equal(x.upstreamCandidatesOmitted,2);
  const s=x.candidates[0].sources[0]; assert.equal(s.pageUrl,'https://school.example/contato/'); assert.equal(s.contactPage,true); assert.equal(s.captureMode,'http'); assert.equal(s.channel,'whatsapp'); assert.equal(s.whatsappEvidenceKind,'VALID_DIRECT_WHATSAPP_LINK'); assert.equal(s.branchLabel,'Cumbuco');
  assert.equal(x.unresolvedWhatsApp[0].whatsappEvidenceKind,'BUTTON_OBSERVED_NUMBER_UNRESOLVED');
});

test('distinguishes unknown suggested primary from an explicit null and fails closed on malformed inventory',()=>{
  const absent=inventory(); delete absent.suggestedPrimary;
  const x=projectContactEvidence(absent); assert.deepEqual(x.suggestedPrimary,{email:{known:false,value:null},phone:{known:false,value:null}});
  const y=projectContactEvidence({status:'nonsense',candidates:[null,{kind:'email',normalizedValue:'x@y.example'}]});
  assert.equal(y.status,'unknown'); assert.equal(y.eligibility,'HOLD'); assert.equal(y.candidatesOmitted,1); assert.equal(y.candidates.length,1);
  assert.deepEqual(y.suggestedPrimary,{email:{known:false,value:null},phone:{known:false,value:null}});
  assert.equal(y.knownContactPagesUncaptured,null);
});

test('bounds arrays and strings and strips query, credentials, and unsafe source text',()=>{
  const long=inventory({coverage:{knownContactPagesUncaptured:['a','b']},candidates:[candidate({normalizedValue:'x'.repeat(400),rawValue:Array(30).fill('v'.repeat(300)),sources:Array(20).fill(source({pageUrl:'https://user:secret@school.example/private/?token=secret',context:'<bad>\u0000'.repeat(100)}))})],unresolvedWhatsApp:Array(1002).fill(source())});
  const x=projectContactEvidence(long); const c=x.candidates[0];
  assert.equal(x.knownContactPagesUncaptured,2); assert.equal(c.normalizedValue,null); assert.equal(c.normalizedValueOmitted,true); assert.equal(c.rawValue.length,20); assert.equal(c.rawValue[0].length,254); assert.equal(c.rawValueTruncated,20);
  assert.equal(c.sources.length,12); assert.equal(c.sourcesOmitted,8); assert.equal(c.sources[0].pageUrl,null); assert.equal(c.sources[0].pageUrlOmitted,true); assert.ok(c.sources[0].truncatedFields.includes('context'));
  assert.ok(!c.sources[0].context.includes('<')); assert.ok(!JSON.stringify(x).includes('secret'));
  assert.equal(x.unresolvedWhatsApp.length,1000); assert.equal(x.unresolvedWhatsAppOmitted,2);
  assert.equal(projectContactEvidence(null).eligibility,'HOLD');
});

test('unsupported ownership claims never become confidence or eligibility',()=>{
 const x=projectContactEvidence(inventory({candidates:[candidate({ownership:'VERIFIED',validation:'TRUSTED'})]}));assert.equal(x.candidates[0].ownership,'unknown');assert.equal(x.candidates[0].validation,'unknown');assert.equal(x.eligibility,'HOLD');
});
