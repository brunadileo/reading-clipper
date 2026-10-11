// READ-345: is the user behind the stored capture token an admin (profiles.role)?
// Asked from the background worker with the same x-reader-token the saves use.
// Fails closed: no token, a bad URL, a non-2xx answer, a network error or an
// unexpected body all mean "not admin". Errors are logged, never swallowed.
// NOTE: the server route getMyRole (auth 'either', answers only { role }) must be deployed;
// until it does, this returns false and every press keeps the hour limit.
import { endpointUrl } from './waiting-api';

export async function fetchIsAdmin(captureUrl: string, token: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
	if (!token) return false;
	const url = endpointUrl(captureUrl, 'getMyRole');
	if (!url) return false;
	try {
		const res = await fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-reader-token': token },
			body: '{}',
		});
		if (!res.ok) {
			console.warn(`Admin check: getMyRole answered ${res.status}, treating as not admin.`);
			return false;
		}
		const json: any = await res.json();
		return (json?.data?.role ?? json?.role) === 'admin';
	} catch (e) {
		console.warn('Admin check failed, treating as not admin.', e);
		return false;
	}
}
