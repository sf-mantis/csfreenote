# 설치본은 어떻게 만들어지는가

> **Summary in English.** csFreeNote is a Windows note-taking app maintained by
> one person. Installers are built **only** by GitHub Actions on GitHub-hosted
> runners ([release.yml](.github/workflows/release.yml)), never on a
> maintainer's machine. A build is triggered by pushing a `v*` tag; it checks
> out that exact commit, installs from `package-lock.json` with `npm ci`,
> **refuses to continue if the tag and the version in `package.json` disagree**,
> runs the full test suite (17 suites, over 700 checks), and only then builds.
> The workflow attaches the installer to that tag's release — or opens a
> **draft** if none exists — and **never publishes**. Release notes are written and the release published by
> the repository owner, [@sf-mantis](https://github.com/sf-mantis), who is the
> only account with push and release rights and has two-factor authentication
> enabled. Every run is public at
> [Actions](https://github.com/sf-mantis/csfreenote/actions). The project is
> **not code-signed yet**; moving to signing is what this document was written
> for. Builds are not bit-for-bit reproducible (electron-builder embeds build
> timestamps), so what can be verified is provenance, not byte equality.

이 문서는 GitHub 릴리즈에 걸린 `csFreeNote-*-setup.exe` 가 어디서 나온
파일인지, 누가 그것을 펴낼 수 있는지를 적어 둔 것이다.

## 만드는 곳

설치본은 **GitHub Actions 가 만든다.** 아무의 PC 에서도 만들지 않는다.

`v` 로 시작하는 태그를 밀면 [release.yml](.github/workflows/release.yml) 이
GitHub 이 제공하는 Windows 기계에서 돈다. 그 안에서 차례로:

1. 태그가 가리키는 커밋을 그대로 받아온다
2. `package-lock.json` 에 적힌 것만 설치한다 (`npm ci`)
3. **태그와 `package.json` 의 판 번호가 다르면 거기서 멈춘다**
4. 검사를 전부 돌린다 — 하나라도 어긋나면 설치본을 만들지 않는다
5. 설치본을 만든다
6. 그 태그의 릴리즈에 파일을 붙인다. 릴리즈가 없으면 **초안**을 연다

실행 기록은 [Actions](https://github.com/sf-mantis/csfreenote/actions) 에
남는다. 어느 커밋에서 무엇이 나왔는지, 검사가 무엇을 통과했는지 누구나 볼 수
있다.

## 펴내는 사람

작업 흐름은 **펴내지 않는다.** 초안까지만 만들고 멈춘다. 릴리즈에 딸리는
설명을 쓰고 펴내는 것은 사람이 한다.

태그를 밀 수 있는 사람과 릴리즈를 펴낼 수 있는 사람은 저장소 소유자
([@sf-mantis](https://github.com/sf-mantis)) 뿐이다. 그 계정은 2단계 인증을
쓴다.

이 프로젝트는 한 사람이 만든다. 그러므로 쓴 사람과 살펴본 사람과 펴낸 사람이
같다 — 여럿이 나눠 맡는 프로젝트와 달리, 여기서 지켜지는 것은 **펴내는 길이
하나뿐이고 그 길이 기록을 남긴다**는 것이다.

## 코드 서명

**지금은 서명하지 않는다.**

그래서 내려받아 실행하면 Windows 가 "알 수 없는 게시자" 라고 하거나
SmartScreen 경고를 띄운다. 그것은 이 파일에 문제가 있다는 뜻이 아니라,
Windows 가 이 파일을 낸 사람이 누구인지 확인할 방법이 없다는 뜻이다.

서명을 붙이는 쪽으로 옮기는 중이다. 옮기고 나면 이 대목을 고친다.

## 받은 파일이 맞는지 확인하려면

릴리즈에 걸린 파일은 그 태그의 커밋에서 나왔다. 확인하는 길은:

- 릴리즈 페이지의 태그를 눌러 **어느 커밋인지** 본다
- [Actions](https://github.com/sf-mantis/csfreenote/actions) 에서 그 태그로
  돌아간 실행을 찾아 **무엇을 했는지** 본다

다만 같은 커밋에서 만들어도 **바이트까지 같은 파일이 나오지는 않는다.**
설치본 안에는 만든 시각 같은 것이 들어가고, electron-builder 는 그것을
없애 주지 않는다. 그러니 여기서 확인할 수 있는 것은 "같은 파일인가" 가
아니라 "**어디서 나온 파일인가**" 다.

## 노트는 설치본이 건드리지 않는다

새 판을 덮어 깔아도 노트·양식·설정은 남는다. 제거할 때는 남길지 지울지
물어본다. 이 동작은 [verify-installer.js](test/verify-installer.js) 가 실제로
설치하고 제거해 가며 확인한다 — 누군가 노트 파일을 붙잡고 있는 동안 덮어
까는 경우까지 포함해서.

자세한 것은 [README](README.md#노트는-어디에-있나) 에 있다.

## 문제를 찾으면

보안과 관련된 것이라면 [이슈](https://github.com/sf-mantis/csfreenote/issues)
로 알려 주기 바란다. 저장소가 공개이고 프로그램은 인터넷에 연결하지 않으므로
(새 판이 있는지 확인할 때만 GitHub 에 한 번 물어본다), 남들이 먼저 알면
곤란한 종류의 문제는 드물 것이다. 그런 경우라면 이슈 대신 저장소 소유자에게
직접 알려 주기 바란다.
