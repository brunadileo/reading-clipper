// ASSUMED SHAPE, not recorded from a live response. Replace with a trimmed real
// response after the live probe (see the plan Run log).
export const substackSavedAssumed = {
	"_note": "ASSUMED SHAPE from reading-wiki/scripts/substack_saved_list.py. Not recorded from a live response. Replace with a trimmed real response after the live probe.",
	"items": [
		{
			"entity_key": "p-1001",
			"post": {
				"canonical_url": "https://example.substack.com/p/first-post",
				"title": "First post",
				"publication": {
					"name": "Example Letter"
				}
			}
		},
		{
			"entity_key": "p-1002",
			"post": {
				"canonical_url": "https://news.customdomain.test/p/second-post",
				"title": "Second post (custom domain)",
				"publication": {
					"name": "Custom Domain News"
				}
			}
		},
		{
			"entity_key": "p-1003",
			"post": {
				"canonical_url": null,
				"title": "No url, dropped",
				"publication": {
					"name": "X"
				}
			}
		}
	],
	"nextCursor": "cursor-2"
};
