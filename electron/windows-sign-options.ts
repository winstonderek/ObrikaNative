import type { SignToolOptions } from '@electron/windows-sign';

/**
 * Azure Artifact Signing (formerly Trusted Signing) has no exportable .pfx.
 * CI downloads the signtool dlib, writes metadata.json, and exports:
 *   AZURE_CODE_SIGNING_DLIB, AZURE_METADATA_JSON, SIGNTOOL_PATH
 * When those are absent, Windows builds stay unsigned (or use a .pfx).
 */
export function azureWindowsSignOptions(): SignToolOptions | undefined {
  const dlib = process.env.AZURE_CODE_SIGNING_DLIB;
  const metadata = process.env.AZURE_METADATA_JSON;
  if (!dlib || !metadata) return undefined;

  return {
    ...(process.env.SIGNTOOL_PATH ? { signToolPath: process.env.SIGNTOOL_PATH } : {}),
    timestampServer: 'http://timestamp.acs.microsoft.com',
    hashes: ['sha256'] as NonNullable<SignToolOptions['hashes']>,
    // /a makes signtool look for a local cert and ignore the dlib.
    automaticallySelectCertificate: false,
    signWithParams: ['/v', '/debug', '/dlib', dlib, '/dmdf', metadata],
  };
}
