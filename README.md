## PokéRogue 安卓 / iOS 离线版（b 站黑咖啡和冰月亮）

##### 宝可梦肉鸽安卓版 + iOS 版，已同步到官方 v1.12.2.6（2026/11/06）

##### Pokémon Rogue for Android and iOS, synced to official v1.12.2.6 (2026/11/06)

[中文](#apk直接安装可玩) · [iOS 安装](#ios-安装) · [English](#english) · [源码与许可证](#源码与许可证--source--license)

#### apk 直接安装可玩

在 [Release](https://github.com/1596941391qq/pokerogue-android/releases) 里下载新打包的 `.apk`，安装即玩，无需登录。
兼容性说明：安卓 11 及以上或 7 及以下可玩，其他版本请看下方群友反馈。

#### iOS 安装

在 [Release](https://github.com/1596941391qq/pokerogue-android/releases) 里下载 `.ipa`（未签名，需要自签），任选一种方式装：

| 方式 | 适合谁 | 说明 |
| --- | --- | --- |
| **TrollStore（巨魔）** | 系统版本支持巨魔的设备 | 用 TrollStore 打开 ipa 直接安装，永久有效，不用续签 |
| **Sideloadly**（Windows / Mac） | 普通用户 | 数据线连电脑 → 把 ipa 拖进 Sideloadly → 登录自己的 Apple ID → Start |
| **AltStore / SideStore** | 普通用户 | 在 AltStore 里点「+」选 ipa 安装，可在手机上自动续签 |

用免费 Apple ID 自签的注意事项：

- 第一次打开前，到「设置 → 通用 → VPN 与设备管理」信任自己的 Apple ID；iOS 16 及以上还要打开「设置 → 隐私与安全性 → 开发者模式」。
- 免费账号签的 App **7 天后会打不开**，用 Sideloadly / AltStore 重新签一次就好（覆盖安装，存档还在）。
- **不要删除 App**，删了存档就没了。换机、重装前先导出存档（见下）。

#### 支持导入导出

游戏里「管理数据 → 导出数据」：
- 安卓：存到下载目录，可以随意导入新的版本，从 zarchiver 读档能基本稳定不崩。
- iOS：弹出分享菜单，可以存到「文件」、发给自己；同时会在「文件 → 我的 iPhone → PokéRogue」里留一份。导入时从「文件」里选这个 `.prsv` 文件。

#### 继承之前存档

每次安装覆盖完会继承之前存档（安卓 APK 签名一直没变，直接覆盖安装即可）。

#### 持续更新，与官网同步

也许是一个月更新一次。当前同步的官方版本和提交写在 [`pokerogue-version.json`](pokerogue-version.json)。

#### 更新说明

中文 wiki 链接：https://wiki.pokerogue.net/zh:changelog:current

#### 打赏链接

<a href="https://smms.app/image/dH5gmwYtMaKBrWO" target="_blank"><img src="https://s2.loli.net/2024/06/02/dH5gmwYtMaKBrWO.jpg" width=212 height=280></a>

### 群友反馈

<a href="https://smms.app/image/fOwC29NYQ81rVvy" target="_blank"><img src="https://s2.loli.net/2024/06/02/fOwC29NYQ81rVvy.png" width=184 height=320></a>

<a href="https://smms.app/image/aqo3BJyw8xTrbOV" target="_blank"><img src="https://s2.loli.net/2024/06/02/aqo3BJyw8xTrbOV.png" width=380 height=120></a>

---

### English

**Android (APK):** download the `.apk` from the [Releases](https://github.com/1596941391qq/pokerogue-android/releases) page and install it. No login needed; play offline. Playable on Android 11 and above or 7 and below; for other versions see the feedback from players above. Every release is signed with the same key, so installing over an older version keeps your save.

**iOS (IPA):** download the unsigned `.ipa` from the same page and install it with one of these:
- **TrollStore**: open the IPA in TrollStore. It stays installed permanently.
- **Sideloadly** (Windows/Mac): connect your iPhone, drop the IPA in, and sign in with your Apple ID.
- **AltStore / SideStore**: tap "+" and pick the IPA. They can refresh the signature on the phone.

With a free Apple ID, trust your profile under Settings → General → VPN & Device Management. On iOS 16+, also turn on Developer Mode under Settings → Privacy & Security. The app has to be re-signed every 7 days; re-installing over it keeps your save. Don't delete the app, because that deletes the save. Export first.

**Saves:** saves live on the device. Use "Manage Data → Export Data" to back them up:
- Android writes the export to Downloads.
- iOS opens the share sheet and also keeps a copy in Files → On My iPhone → PokéRogue.

**Updates:** synced with the official game roughly once a month. The exact upstream version is in [`pokerogue-version.json`](pokerogue-version.json).

---

### 源码与许可证 / Source & License

- 游戏本体是 **PokéRogue**，作者 Pagefault Games 及贡献者，按 **GNU AGPL-3.0** 开源：https://github.com/pagefaultgames/pokerogue 。本仓库把它的离线版本打包成安卓 / iOS App，`pkmain/pokerogue` 子模块就是所用的官方源码版本，许可证全文见 [LICENSE](LICENSE)。
  The game is **PokéRogue** by Pagefault Games and contributors, licensed under the **GNU AGPL-3.0**: https://github.com/pagefaultgames/pokerogue. This repository packages its offline build as Android and iOS apps. The `pkmain/pokerogue` submodule pins the exact upstream source that was built. The full license text is in [LICENSE](LICENSE).
- 打包源码（安卓壳、iOS 壳、同步脚本）就在本仓库：https://github.com/1596941391qq/pokerogue-android
  The packaging source (Android shell, iOS shell, sync script) is this repository: https://github.com/1596941391qq/pokerogue-android
- 本项目是粉丝作品，与任天堂、Game Freak、The Pokémon Company 无关。Pokémon 及相关名称是其各自权利人的商标。
  This is an unofficial fan project, not affiliated with Nintendo, Game Freak, or The Pokémon Company. Pokémon and related names are trademarks of their respective owners.

#### 自己构建 / Build it yourself

```bash
# 1. 拉官方源码并构建离线版到 app/src/main/assets/web（不带参数就是当前子模块版本）
scripts/sync-pokerogue.sh v1.12.2.6

# 2. 安卓（JDK 17 + Android SDK 34）
./gradlew assembleRelease        # 输出 app/build/outputs/apk/release/

# 3. iOS（macOS + Xcode），输出未签名 ipa
ios/build-ipa.sh build/ios/PokeRogue.ipa
```

iOS 工程在 `ios/PokeRogue.xcodeproj`，直接引用 `app/src/main/assets/web`，安卓和 iOS 用的是同一份游戏文件。
The iOS project at `ios/PokeRogue.xcodeproj` reads the same `app/src/main/assets/web` folder as the Android app.
