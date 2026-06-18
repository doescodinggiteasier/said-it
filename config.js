/* Said It? — runtime config. Edit this one file; no rebuild needed.
 *
 * LOG_ENDPOINT  — paste the URL of your deployed logging endpoint here (see ../endpoint/).
 *                 Until it's set, the app still tracks return/streak locally on each device
 *                 (so the D1/D7 *return* signal survives), it just can't aggregate across people.
 * AGG_ENDPOINT  — optional. A read endpoint that returns {fooled_most_idx, fooled_pct} for ?day=YYYY-MM-DD,
 *                 to show "the fake that fooled the most players today". Leave "" to use the editorial
 *                 `trickiest_fake` from each daily file instead.
 */
window.SAIDIT_CONFIG = {
  LOG_ENDPOINT: "https://script.google.com/macros/s/AKfycbxyjy6u1c3lU9q4FdTVX_6rm5t3T7nRcu3wYRzNvdyH5EP4xl96DCudAvHM79Ov9b8z/exec",
  AGG_ENDPOINT: "https://script.google.com/macros/s/AKfycbxyjy6u1c3lU9q4FdTVX_6rm5t3T7nRcu3wYRzNvdyH5EP4xl96DCudAvHM79Ov9b8z/exec"
};
/* Admin dashboard (G-A): open /admin/dashboard.html?k=<ADMIN_TOKEN>. The token is NOT stored here (this
 * file is public) — it lives only in the endpoint (Apps Script Script Property / Worker env var ADMIN_TOKEN)
 * and in the unguessable URL you keep private. The dashboard reuses AGG_ENDPOINT/LOG_ENDPOINT above. */
