const publicLinks = {};
const params = new URLSearchParams(window.location.search);
const config = {
  debug: params.get('debug') || false,
  origin: params.get('origin'),
  variation: params.get('locationPicker') ? 'location' : 'resource',
  publicLink: params.get('publicLink') || false,
  publicLinkDuration: parseInt(params.get('publicLinkDuration'), 10),
  publicLinkDescription: params.get('publicLinkDescription'),
  server: null,
  authority: null,
  clientId: null,
  accessToken: null,
};

const filepickerContainer = document.querySelector('#filepicker-container');
const filepickerElem = document.createElement('file-picker');
filepickerElem.id = 'file-picker';
filepickerElem.setAttribute('variation', config.variation);
filepickerElem.setAttribute('is-select-btn-displayed', false);
filepickerContainer.appendChild(filepickerElem);

const wildcardToRegex = s => {
  return new RegExp('^' + s.split(/\*+/).map(regexEscape).join('.*') + '$');
};

const regexEscape = s => {
  return s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
};

const parseParams = async () => {
  if (!config.origin) {
    throw new Error('You must specify a origin query parameter');
  }

  const allowedOrigins = await getAllowedOrigins();
  for (allowedOrigin of allowedOrigins) {
    if (config.origin.match(wildcardToRegex(allowedOrigin))) {
      return;
    }
  }

  throw new Error(`Invalid origin ${config.origin}`);
};

const getConfig = async () => {
  if (config.debug) console.info('fetching configuration');

  const configRes = await fetch('file-picker-config.json');
  const configData = await configRes.json();
  config.server = configData.server;
  config.authority = configData.openIdConnect.authority;
  config.clientId = configData.openIdConnect.client_id;
};

const getAllowedOrigins = async () => {
  const allowedOriginsRes = await fetch('allowed-origins.json');
  const allowedOrigins = await allowedOriginsRes.json();
  return allowedOrigins;
};

const checkAccessToken = async (accessToken, expiresAt) => {
  const accessCheckUrl = `${config.server}/remote.php/webdav/?access_token=${accessToken}`;
  try {
    await fetch(accessCheckUrl, { method: 'HEAD', headers: { Authorization: `Bearer ${accessToken}` } });
    return true;
  } catch (e) {
    if (expiresAt < Date.now() / 1000) {
      if (config.debug) console.info('access token is expired, auth will take care of it');
      return false;
    }
    // Right now cernbox causes a cors error when not authenticated, so there is no way to check status.
    if (config.debug) console.info('access token does not seem to work, cleaning up');
    sendSelection();
    sessionStorage.clear();
    location.reload();
    return false;
  }
};

const getAccessToken = async () => {
  const authKey = JSON.parse(sessionStorage.getItem(`oc_oAuthuser:${config.authority}:${config.clientId}`));

  if (!authKey) {
    config.accessToken = null;
    return;
  }

  const valid = await checkAccessToken(authKey.access_token, authKey.expires_at);
  config.accessToken = valid ? authKey.access_token : null;
};

const handleUpdateBasic = paths => {
  return paths.map(path => `${config.server}/remote.php/webdav${path}?access_token=${config.accessToken}`);
};

const generatePublicLink = async () => {
  const publicLinkRequestUrl = `${config.server}/ocs/v1.php/apps/files_sharing/api/v1/shares`;
  const data = new FormData();
  data.append('shareType', 3);
  data.append('path', path);
  data.append('permissions', 1);
  data.append('internal', true);
  if (config.publicLinkDuration) {
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + config.publicLinkDuration);
    data.append('expireDate', expireDate.toISOString());
  }
  if (config.publicLinkDescription) {
    data.append('description', config.publicLinkDescription);
  }

  const publicLinkRes = await fetch(publicLinkRequestUrl, {
    method: 'POST',
    body: data,
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });
  const publicLinkText = await publicLinkRes.text();
  const parser = new DOMParser();
  const publicLinkDocument = parser.parseFromString(publicLinkText, 'text/xml');
  const token = publicLinkDocument.querySelector('token').textContent;
  const fileName = path.split('/').pop();
  return `${config.server}/remote.php/dav/public-files/${token}/${encodeURIComponent(fileName)}`;
};

const handleUpdatePublicLink = async paths => {
  newPaths = paths.filter(path => !publicLinks[path]);
  for (path of newPaths) {
    publicLinks[path] = await generatePublicLink(path);
  }

  if (config.debug) console.info('public link cache', publicLinks);
  return paths.map(path => publicLinks[path]);
};

const sendSelection = (payload = { files: [], ready: false }) => {
  if (config.debug) console.info('sending message to parent', payload, config.origin);
  window.parent.postMessage(payload, config.origin);
};

async function handleUpdateSelection(event) {
  // Send clear selected files and not ready while the filepicker works.
  sendSelection();

  // Get the newest access token.
  if (!config.clientId) {
    await getConfig();
  }
  await getAccessToken();

  const paths = event.detail[0].map(r => r.path);
  const files = config.publicLink ? await handleUpdatePublicLink(paths) : handleUpdateBasic(paths);

  sendSelection({ files, ready: true });
}

async function handleUpdateLocation(event) {
  const paths = event.detail[0].map(r => r.path);

  if (!paths.length) {
    sendSelection();
    return;
  }

  const username = sessionStorage.getItem('sub');
  await getAccessToken();

  sendSelection({ files: paths, username, accessToken: config.accessToken, ready: true });
}

(async () => {
  await parseParams();
  await getConfig();
  await getAccessToken();

  const filePickerElem = document.getElementById('file-picker');

  if (config.variation === 'resource') {
    filePickerElem.addEventListener('update', handleUpdateSelection);
  } else if (config.variation === 'location') {
    filePickerElem.addEventListener('update', handleUpdateLocation);
  }
})();
