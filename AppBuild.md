# Building the Galaxy Media Player APK - beginner's guide

## Prebuilt APK vs building your own

If a prebuilt APK is available (check this project's GitHub Releases), you can skip this
whole guide: install it, enter your server URL, pair. The app has no server baked in, so
anyone's build works with anyone's server.

The catch is Android's signing rule: **a TV only accepts updates signed with the same key
as the installed app.** So:

- Using the **prebuilt APK** means your System-tab self-updates must also be prebuilt
  releases from this project - you depend on it for future player versions.
- **Building your own** (this guide) with your own keystore makes you fully independent:
  you build and publish updates on your own schedule. Recommended if you run client
  fleets. Switching a TV between differently-signed builds requires uninstall + re-pair.

---

You do **not** create a new project - the app already exists in [`player-android/`](player-android/).
You just open it in Android Studio and press build. Total time first run: ~30-45 min
(mostly downloads); after that, a rebuild takes under a minute.

---

## 1. Install Android Studio

1. Download from <https://developer.android.com/studio> (big green button, Windows installer).
2. Run the installer, accept all defaults.
3. First launch opens a **Setup Wizard** → choose **Standard** setup → accept the license
   agreements → let it download the Android SDK (a few GB, one-time).

Android Studio bundles its own Java (JDK) - you don't need to install Java separately.

## 2. Open the project

1. On the welcome screen click **Open** (not "New Project").
2. Browse to `<path-to-repo>\player-android` and select that
   folder (the one containing `settings.gradle.kts`) → **OK**.
3. If asked "Trust this project?" → **Trust**.
4. Now wait. The bottom status bar shows **Gradle sync** - the first sync downloads Gradle,
   the Android build plugin, and all libraries (5-15 min depending on connection).
   - If a popup asks to install a missing SDK platform (e.g. "Android SDK 35") or accept
     licenses → click **Install/Accept** and let it finish.
5. Done when the status bar is idle and the project tree on the left shows
   `app > java > com.galaxymedia.player` without red errors.

## 3. Build a release APK (what you want for real TVs)

The server has trusted TLS via `https://signage.example.com`, so use the **release** build.
Release APKs must be signed - you create a signing key once and reuse it for every
future version (the TV uses it to verify updates are really from you).

1. Menu **Build → Generate Signed App Bundle / APK…**
2. Choose **APK** → Next.
3. Under *Key store path* click **Create new…**:
   - **Key store path:** somewhere OUTSIDE the repo, e.g.
     `<somewhere-safe>\galaxy-release.jks`
   - **Passwords:** pick one, you'll need it every build
   - **Alias:** `galaxy` · validity 25+ years · fill in any name/org → OK
   - ⚠️ **Back up this file and record the password in `deets.md`.** Lose it and you can
     never update the app on existing TVs without re-pairing them all.
4. Next → tick **release** → **Create**.
5. When the "Build completed" balloon appears, click **locate**. Your APK is at:
   `player-android\app\release\app-release.apk`

*(Debug alternative: menu **Build → Build App Bundle(s) / APK(s) → Build APK(s)** - no key
needed, output in `app\build\outputs\apk\debug\`. Fine for a first smoke test.)*

## 4. Prepare the TV (TCL / Android TV)

On the TV:

1. **Settings → System → About** (on some TCLs: *Settings → More Settings → Device Preferences → About*).
2. Scroll to **Build** and click OK on it **7 times** → "You are now a developer!"
3. Back in Settings → **Developer options** → enable **USB debugging** (and
   **Network debugging** / "ADB over network" if offered - handy).
4. Note the TV's IP address: **Settings → Network → your Wi-Fi/Ethernet → IP address**.

## 5. Install the APK on the TV

**Option A - USB stick (no PC tools needed):**
1. Copy `app-release.apk` onto a USB stick, plug it into the TV.
2. Install a file manager from the TV's Play Store if none is present
   ("File Manager" / "FX File Explorer").
3. Open the APK from the stick → if prompted, allow "Install unknown apps" for the file
   manager → **Install**.

**Option B - over the network with adb (faster for repeat installs):**
Android Studio already installed adb. In a PowerShell window:
```powershell
cd $env:LOCALAPPDATA\Android\Sdk\platform-tools
.\adb connect <TV_IP>:5555        # accept the popup on the TV the first time
.\adb install -r "<path-to-repo>\player-android\app\release\app-release.apk"
```
(`-r` reinstalls/updates in place - use the same command for every new build.)

## 6. First launch & pairing

1. Before touching the TV: in the admin UI (<https://signage.example.com>) upload an image or two
   and create a playlist + assignment, so the screen has something to play.
2. Launch **Galaxy Media Player** on the TV (in the apps row).
3. Server URL screen: enter `https://signage.example.com` and confirm.
4. The TV shows a **6-character pairing code**.
5. Admin UI → **Screens** → type the code, name the screen, pick a group → **Pair screen**.
6. Within ~10 seconds the TV downloads the media and starts playing.

**Then run the two acceptance tests:** pull the TV's network mid-playback (must keep looping),
and reboot it offline (must come back playing with no remote-control input).

7. **For OTA self-updates to work**, allow "Install unknown apps" for the *Galaxy Media
   Player* app itself: **Settings → Apps → Special app access → Install unknown apps →
   Galaxy Media Player → Allow**. (Step 5's prompt only covered the file manager/adb.
   If you skip this, Android shows the permission screen on the TV at the first OTA
   update instead - one click with the remote, but better done now while you're here.)

## 7. Releasing updates (after the first install)

You only sideload manually once per TV. For every release after that:

1. Bump `versionCode` (and `versionName`) in `player-android/app/build.gradle.kts` -
   the TV updates only when the code is higher than what it runs.
2. Build the signed release APK exactly as in step 3 (same keystore - a different key
   is rejected by Android).
3. Admin UI -> **System** tab -> upload the APK with its version code/name.
4. TVs check every ~6 hours (or immediately when you press **Reload** on the Screens
   page), verify the file hash, and show the install prompt. The first time, grant
   "Install unknown apps" to Galaxy Media Player on the TV when asked.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Gradle sync fails with a download error | Check internet/VPN/antivirus; then **File → Sync Project with Gradle Files** to retry |
| "SDK location not found" | Android Studio usually fixes this itself; otherwise **File → Project Structure → SDK Location** |
| Red errors mentioning licenses | **Tools → SDK Manager**, accept licenses, re-sync |
| TV refuses to install the APK | Enable "Install unknown apps" for the file manager, or use adb (Option B) |
| App can't reach the server | Test `https://signage.example.com/api/health` in the TV browser or your phone on the same network |
| Pairing code expired | It rotates automatically every 15 min - just use the code currently on screen |
| adb connect refused | Enable Network/ADB debugging on the TV and accept the authorization popup |
