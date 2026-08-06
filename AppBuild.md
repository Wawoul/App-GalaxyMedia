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

**TCL sets specifically** - the USB-stick menu path and a couple of settings are in
different places than stock Android TV:
1. Plug in the USB stick with the APK on it.
2. Open **"Safety Guard"** (or any file explorer app if that's not present) →
   **App manager → Installation → USB** → select Galaxy Media Player → install.
3. **Settings → Apps → Special access → Energy optimisations** → disable it for
   Galaxy Media Player (TCL's battery optimizer otherwise throttles/kills background
   apps, which fights the "stays running unattended" requirement).
4. **Settings → Security & restrictions → Unknown sources** → enable for
   Galaxy Media Player (TCL's equivalent of "Install unknown apps" - needed both for
   this sideload and for approving app updates later).

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

7. **For app updates to install later**, allow "Install unknown apps" for the *Galaxy Media
   Player* app itself: **Settings → Apps → Special app access → Install unknown apps →
   Galaxy Media Player → Allow**. (Step 5's prompt only covered the file manager/adb.
   If you skip this, Android shows the permission screen on the TV the first time a tech
   sends an "Install latest app update" command instead - one click with the remote, but
   better done now while you're here.)

## 7. Let the app restart itself (unattended screens)

Do this on any screen nobody is going to be standing next to. It is one command,
and it is the difference between a screen that recovers on its own and one that
sits on the TV's home screen until someone visits it.

The player runs as a foreground service so Android does not evict it under memory
pressure - the usual reason a screen quietly drops back to the apps row after days
of uptime. If it dies anyway, a watchdog relaunches it. But since Android 10 an app
with no visible window is not allowed to start an activity at all, so that relaunch
only works if the app holds the "draw over other apps" permission. Android TV has
no Settings UI for it, which is why this is an adb command.

**Connect to the TV** (from any machine on the same network as the TV - this is the
same `adb connect` used for installs, and the TV needs Network/ADB debugging on from
step 4):

```powershell
cd $env:LOCALAPPDATA\Android\Sdk\platform-tools
.\adb connect <TV_IP>:5555     # accept the popup on the TV the first time
```

The TV's IP is in **Settings → Network → your connection → IP address**. Use the
TV's *own* address, not the router's - on a routed network they differ, and the
address the dashboard shows under "Health" is the one the server saw the traffic
come from, which may be neither.

**Grant the permission, then confirm it took:**

```powershell
.\adb shell appops set com.galaxymedia.player SYSTEM_ALERT_WINDOW allow
.\adb shell appops get com.galaxymedia.player SYSTEM_ALERT_WINDOW
```

(Drop the `.\` if adb is on your PATH, or on Linux/macOS.)

The second command must print `allow`. Check it rather than assuming - a set that
did not apply prints something like `SYSTEM_ALERT_WINDOW: default; rejectTime=...`,
which means the permission was refused and the watchdog cannot relaunch the app. If
you see that, reboot the TV and run the set again.

Skipping this section is safe: you keep the foreground service and lose only the
self-relaunch backstop.

## 8. Releasing updates (after the first install)

You only sideload manually once per TV. For every release after that:

1. Bump `versionCode` (and `versionName`) in `player-android/app/build.gradle.kts` -
   the TV updates only when the code is higher than what it runs.
2. Build the signed release APK exactly as in step 3 (same keystore - a different key
   is rejected by Android).
3. Admin UI -> **System** tab -> upload the APK with its version code/name.
4. Nothing installs on its own - on the Screens page, use **"Install latest app
   update…"** on each TV once a tech is on-site to approve the resulting Android
   install prompt (it stops playback until someone taps it, which is exactly why
   it isn't automatic or bundled with Reload). The TV verifies the file hash first;
   the first time, grant "Install unknown apps" to Galaxy Media Player when asked.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Gradle sync fails with a download error | Check internet/VPN/antivirus; then **File → Sync Project with Gradle Files** to retry |
| "SDK location not found" | Android Studio usually fixes this itself; otherwise **File → Project Structure → SDK Location** |
| Red errors mentioning licenses | **Tools → SDK Manager**, accept licenses, re-sync |
| TV refuses to install the APK | Enable "Install unknown apps" for the file manager, or use adb (Option B) |
| App can't reach the server | Test `https://signage.example.com/api/health` in the TV browser or your phone on the same network |
| Pairing code expired | It rotates automatically every 15 min - just use the code currently on screen |
| adb connect refused | Enable Network/ADB debugging on the TV and accept the authorization popup |
| Screen plays fine but Reports stay empty | Read the device log (below) - the screen looking healthy tells you nothing about whether the play was recorded |

## 10. Reading the device log

The dashboard shows what the screen *reports*, which is not the same as what it
is *doing*. A screen can play perfectly, heartbeat every 45s and show the right
"now playing" while silently recording nothing. When playback behaves oddly, go
to the device log first - it is usually quicker than reasoning from server data,
and it is the only place that shows what the player is actually doing.

From a machine on the same network as the TV:

```powershell
cd $env:LOCALAPPDATA\Android\Sdk\platform-tools
.\adb connect <TV_IP>:5555
.\adb logcat -c                                    # clear old lines first
.\adb logcat | findstr /i "galaxymedia ExoPlayer"  # Linux/macOS: grep -iE "galaxymedia|ExoPlayer"
```

Let it run through two or three items, then read it:

- `ExoPlayerImpl: Init` **once**, then steady playback, is healthy. The player is
  built once and reused for every item.
- `ExoPlayerImpl: Release` followed by `Init` **between items** means playback is
  being torn down and restarted. If that happens part-way through an item, the
  item never reaches its end, so it is never recorded as a play - the screen
  looks fine and Reports stay empty. This is what a schedule being re-applied
  when nothing actually changed looks like.
- `MediaCodec` lines around a changeover are normal - that is just the decoder
  being swapped for the next file.

Cross-check against the server: a play should be written at the moment an item
ends, and the gap between consecutive plays should match the media's real
duration. A gap noticeably shorter than the file is a sign playback is being
restarted early rather than finishing.
