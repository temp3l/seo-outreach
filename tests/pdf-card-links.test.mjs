import test from 'node:test';
import assert from 'node:assert/strict';
import { cardLinksMatch } from '../scripts/compat/pdf-card-links.mjs';

test('Poppler annotations must belong to the corresponding card, including derived image cards', () => {
 const topics=[{title:'Image links to review',urls:[{url:'https://example.test/image'}]},{title:'Missing main heading',urls:[{url:'https://example.test/heading'}]}];
 const label = url => new URL(url).pathname.slice(1);
 const xml=(a,b)=>`<pdf2xml><page><text>Key observations</text><text>Image links to review</text><text>Example page: <a href="${a}">image</a></text><text>Missing main heading</text><text>Example page: <a href="${b}">heading</a></text><text>Let’s get in touch</text></page></pdf2xml>`;
 assert.equal(cardLinksMatch(xml(topics[0].urls[0].url,topics[1].urls[0].url),topics,'en',label),true);
 assert.equal(cardLinksMatch(xml(topics[1].urls[0].url,topics[0].urls[0].url),topics,'en',label),false);
 assert.equal(cardLinksMatch('<pdf2xml/>',topics,'en',label),false);
 const footerOnly='<pdf2xml><page><text>Key observations</text><text>Image links to review</text><text>Example page</text><text>Let’s get in touch</text><text><a href="https://example.test/image">Footer</a></text></page></pdf2xml>';
 assert.equal(cardLinksMatch(footerOnly,[topics[0]],'en',label),false);
 const unrelated='<pdf2xml><page><text>Key observations</text><text>Image links to review</text><text>Example page: image</text><text>Some unrelated <a href="https://example.test/image">link</a></text><text>Let’s get in touch</text></page></pdf2xml>';
 assert.equal(cardLinksMatch(unrelated,[topics[0]],'en',label),false);
 const single = [{title:'Image links to review',urls:[{url:'https://example.test/homepage'}]}];
 const doc=body=>`<pdf2xml><page><text>Key observations</text><text>Image links to review</text>${body}<text>Let’s get in touch</text></page></pdf2xml>`;
 const expected='https://example.test/homepage';
 assert.equal(cardLinksMatch(doc(`<text>Example page: <a href="${expected}">h</a><a href="https://wrong.test/">omepage</a></text>`),single,'en',label),false);
 assert.equal(cardLinksMatch(doc(`<text>Example page: homepage <a href="${expected}">home</a></text>`),single,'en',label),false);
 assert.equal(cardLinksMatch(doc(`<text>Example page: </text><text><a href="${expected}">home</a></text><text><a href="${expected}">page</a></text>`),single,'en',label),true);

});
