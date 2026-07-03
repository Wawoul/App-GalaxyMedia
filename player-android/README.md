# Galaxy Media Player (Android TV)

Native Kotlin player for TCL / Android TV (API 24+).

## Build

Open this folder in **Android Studio** (it will generate the Gradle wrapper on first sync), or:

```bash
gradle assembleDebug        # debug APK (allows plain-HTTP dev servers)
gradle assembleRelease      # release APK - sign with your own keystore
```

APK output: `app/build/outputs/apk/`.

## Install on a TCL TV

1. Enable **Developer options** (Settings → About → click Build 7×) and **USB debugging**,
   or enable "Install unknown apps" and sideload via USB stick / `adb install`.
2. Launch **Galaxy Media Player**, enter your server URL once.
3. The TV shows a 6-character pairing code - claim it in the admin UI (Screens → Pair screen).
4. Recommended TCL settings: disable screensaver and daydream, set the app to wake with the TV.

## Behavior

- Content is downloaded to local storage (checksum-verified) and always plays from cache - network loss or server downtime never blanks the screen.
- Boots straight into playback (BOOT_COMPLETED receiver), reconnects and resyncs silently.
- Unpairing from the admin UI wipes the token and cached content and returns to the pairing screen.
- Debug builds permit `http://` for LAN testing; release builds require HTTPS.
