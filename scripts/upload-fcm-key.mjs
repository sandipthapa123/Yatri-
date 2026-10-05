// Attach a Firebase service account key to both apps' EAS projects for Android push notifications (FCM V1).
// The same calls `eas credentials` makes, without its arrow-key menus, so it can be run as one command:
//
//   node scripts/upload-fcm-key.mjs "<path to the Firebase service account .json>"
//
// Uses the Expo session of `eas-cli login` on this computer. Prints what it did in plain sentences and never prints the
// key. Safe to run again: an app that already has a key is left alone. Keep the key file outside the repository.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPS = [
  { fullName: '@yatri.ride/yatri-passenger', applicationIdentifier: 'app.yatri.passenger' },
  { fullName: '@yatri.ride/yatri-driver', applicationIdentifier: 'app.yatri.driver' },
];

function fail(message) {
  console.log(`Stopped: ${message}`);
  process.exit(1);
}

const keyPath = process.argv[2];
if (!keyPath) fail('give the path of the Firebase service account file after the script name.');

let jsonKey;
try {
  jsonKey = JSON.parse(readFileSync(keyPath, 'utf8'));
} catch {
  fail(`could not read a JSON file at ${keyPath}.`);
}
if (
  jsonKey.type !== 'service_account' ||
  !jsonKey.private_key ||
  !jsonKey.client_email ||
  !jsonKey.project_id
) {
  fail('that file is not a Firebase service account key.');
}

let session;
try {
  session = JSON.parse(readFileSync(join(homedir(), '.expo', 'state.json'), 'utf8')).auth
    ?.sessionSecret;
} catch {
  // handled below
}
if (!session) fail('not signed in to Expo on this computer. Run: npx.cmd eas-cli login');

async function gql(query, variables) {
  const res = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'expo-session': session },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) fail(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

const APP_QUERY = `query ($fullName: String!, $id: String!) {
  app { byFullName(fullName: $fullName) {
    id
    ownerAccount { id }
    androidAppCredentials(filter: { applicationIdentifier: $id }) { id googleServiceAccountKeyForFcmV1 { id } }
  } }
}`;

let keyId = null;
for (const { fullName, applicationIdentifier } of APPS) {
  const app = (await gql(APP_QUERY, { fullName, id: applicationIdentifier })).app.byFullName;
  let creds = app.androidAppCredentials[0];
  if (creds?.googleServiceAccountKeyForFcmV1) {
    console.log(`${fullName}: already has a push key. Left as it is.`);
    continue;
  }
  if (!keyId) {
    keyId = (
      await gql(
        `mutation ($input: GoogleServiceAccountKeyInput!, $accountId: ID!) {
          googleServiceAccountKey { createGoogleServiceAccountKey(googleServiceAccountKeyInput: $input, accountId: $accountId) { id } }
        }`,
        { input: { jsonKey }, accountId: app.ownerAccount.id },
      )
    ).googleServiceAccountKey.createGoogleServiceAccountKey.id;
    console.log(`Uploaded the key for Firebase project ${jsonKey.project_id}.`);
  }
  if (!creds) {
    creds = (
      await gql(
        `mutation ($appId: ID!, $id: String!) {
          androidAppCredentials { createAndroidAppCredentials(androidAppCredentialsInput: {}, appId: $appId, applicationIdentifier: $id) { id } }
        }`,
        { appId: app.id, id: applicationIdentifier },
      )
    ).androidAppCredentials.createAndroidAppCredentials;
  }
  await gql(
    `mutation ($credsId: ID!, $keyId: ID!) {
      androidAppCredentials { setGoogleServiceAccountKeyForFcmV1(id: $credsId, googleServiceAccountKeyId: $keyId) { id } }
    }`,
    { credsId: creds.id, keyId },
  );
  console.log(`${fullName}: push key attached.`);
}

for (const { fullName, applicationIdentifier } of APPS) {
  const app = (await gql(APP_QUERY, { fullName, id: applicationIdentifier })).app.byFullName;
  const ok = !!app.androidAppCredentials[0]?.googleServiceAccountKeyForFcmV1;
  console.log(`Check: ${fullName} ${ok ? 'has its push key. Done.' : 'still has no push key.'}`);
}
