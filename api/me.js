import { route, send, requireUser, publicUser } from '../lib/auth.js';
export default route(['GET'], async (req, res) => { send(res, 200, { user: publicUser(await requireUser(req)) }); });
