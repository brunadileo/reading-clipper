import { expandShortenedLinks } from './expand-short-links';
import Defuddle from 'defuddle/full';
import { setElementHTML } from './dom-utils';

// Parse document content for clipping. In reader mode, extracts from
// the article's original HTML to avoid reader UI artifacts.
export function parseForClip(doc: Document) {
	const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article');
	if (readerArticle) {
		const readerDoc = doc.implementation.createHTMLDocument();
		const originalHtml = readerArticle.getAttribute('data-original-html');
		if (originalHtml) {
			setElementHTML(readerDoc.body, originalHtml);
		} else {
			readerDoc.body.replaceChildren(
				...Array.from(readerArticle.childNodes).map(n => readerDoc.importNode(n, true))
			);
		}
		return new Defuddle(readerDoc, { url: '' }).parse();
	}
	// READ-358: X cuts long links with an ellipsis; show the full address for the parse.
	const restoreLinks = expandShortenedLinks(doc, doc.URL);
	try {
		return new Defuddle(doc, { url: doc.URL }).parse();
	} finally {
		restoreLinks();
	}
}
