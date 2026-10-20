import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { PublisherGithub } from '@electron-forge/publisher-github';
import path from 'node:path';
import { generateUpdateManifests } from './scripts/generate-update-manifests';
import { azureWindowsSignOptions } from './windows-sign-options';

const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const windowsCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
const azureSign = azureWindowsSignOptions();

const pfxSign =
  !azureSign && windowsCertificateFile && windowsCertificatePassword
    ? {
        certificateFile: windowsCertificateFile,
        certificatePassword: windowsCertificatePassword,
        timestampServer: 'http://timestamp.digicert.com',
        hashes: ['sha256' as const],
      }
    : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Obrika',
    executableName: 'obrika',
    appBundleId: 'com.dereksolutions.obrika',
    asar: true,
    extraResource: [path.resolve(__dirname, 'app-update.yml')],
    icon: path.resolve(__dirname, 'assets', 'icon'),
    win32metadata: {
      CompanyName: 'Obrika',
      FileDescription: 'Obrika',
      ProductName: 'Obrika',
      InternalName: 'Obrika',
    },
    extendInfo: {
      NSUserNotificationsUsageDescription:
        'Obrika can notify you about messages and activity when the app is in the background.',
      NSUserNotificationAlertStyle: 'alert',
      NSCameraUsageDescription: 'Obrika needs camera access for video calls.',
      NSMicrophoneUsageDescription: 'Obrika needs microphone access for calls.',
      NSScreenCaptureUsageDescription:
        'Obrika needs screen recording permission so you can share your screen during calls.',
    },
    osxSign: process.env.APPLE_IDENTITY
      ? {
          identity: process.env.APPLE_IDENTITY,
          hardenedRuntime: true,
          'gatekeeper-assess': false,
          entitlements: path.resolve(__dirname, 'entitlements.plist'),
          'entitlements-inherit': path.resolve(__dirname, 'entitlements.plist'),
        }
      : undefined,
    osxNotarize:
      process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD
        ? {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID!,
          }
        : undefined,
    ...(azureSign ? { windowsSign: azureSign } : pfxSign ? { windowsSign: pfxSign } : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      // NuGet id → Start Menu AUMID `com.squirrel.Obrika.obrika` (must match WINDOWS_SQUIRREL_APP_ID).
      name: 'Obrika',
      setupExe: 'Obrika-Setup.exe',
      setupIcon: path.resolve(__dirname, 'assets', 'icon.ico'),
      // Squirrel downloads this into shortcuts (Start Menu / desktop / taskbar).
      // Without it, pins go blank after an update when the old app-* folder is deleted.
      iconUrl:
        process.env.SQUIRREL_ICON_URL ||
        'https://raw.githubusercontent.com/winstonderek/ObrikaNative/main/electron/assets/icon.ico',
      ...(azureSign
        ? { windowsSign: azureSign }
        : windowsCertificateFile && windowsCertificatePassword
          ? {
              certificateFile: windowsCertificateFile,
              certificatePassword: windowsCertificatePassword,
            }
          : {}),
    }),
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerDMG((arch) => ({
      name: arch === 'x64' ? 'intel-obrika' : 'Obrika',
      icon: path.resolve(__dirname, 'assets', 'icon.icns'),
    })),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner:
          process.env.GITHUB_REPOSITORY?.split('/')[0] ??
          process.env.GITHUB_REPOSITORY_OWNER ??
          'winstonderek',
        name:
          process.env.GITHUB_REPOSITORY?.split('/')[1] ??
          process.env.GITHUB_REPOSITORY_NAME ??
          'ObrikaNative',
      },
      prerelease: false,
      // Drafts are invisible to electron-updater. CI sets GITHUB_RELEASE_DRAFT=false on tags.
      draft: process.env.GITHUB_RELEASE_DRAFT !== 'false',
    }),
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
  hooks: {
    postMake: async (_config, makeResults) => generateUpdateManifests(_config, makeResults),
  },
};

export default config;
