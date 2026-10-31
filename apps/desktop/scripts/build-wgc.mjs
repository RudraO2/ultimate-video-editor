// Builds OpenScreen's Windows capture helpers (native/wgc-capture) and copies
// wgc-capture.exe and cursor-sampler.exe into native/bin/win32-x64/.
//
// Needs Visual Studio Build Tools (2019 or newer) with the C++ workload and a
// Windows 10 SDK. C++/WinRT headers are generated from this machine's own
// Windows metadata (C:\Windows\System32\WinMetadata), so APIs newer than the
// installed SDK (Windows 11 capture options) are available; the generator comes
// from the Microsoft.Windows.CppWinRT NuGet package, cached under %LOCALAPPDATA%.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('The capture helpers are Windows programs; nothing to build here.')
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'native', 'wgc-capture')
const build = join(source, 'build')
const bin = join(here, '..', 'native', 'bin', 'win32-x64')
const cache = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'uve-build')
// The generator that matches VS 2019's compiler; newer ones hit an internal compiler error in 14.29.
const CPPWINRT_VERSION = '2.0.210806.1'

const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
if (!existsSync(vswhere)) throw new Error('Visual Studio Build Tools not found (no vswhere.exe). Install them with the C++ workload.')
const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
if (!vs) throw new Error('Visual Studio has no C++ tools. Add the "Desktop development with C++" workload.')
const vcvars = join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
const cmakeBin = join(vs, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin')
const ninjaBin = join(vs, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja')

// C++/WinRT headers from the system's metadata.
const tool = join(cache, `cppwinrt-${CPPWINRT_VERSION}`)
const generator = join(tool, 'bin', 'cppwinrt.exe')
if (!existsSync(generator)) {
  mkdirSync(tool, { recursive: true })
  const zip = join(tool, 'package.zip')
  const response = await fetch(`https://www.nuget.org/api/v2/package/Microsoft.Windows.CppWinRT/${CPPWINRT_VERSION}`)
  if (!response.ok) throw new Error(`Could not download C++/WinRT (${response.status}).`)
  writeFileSync(zip, Buffer.from(await response.arrayBuffer()))
  // Windows' own bsdtar reads zip files; a GNU tar earlier on PATH (Git Bash) would take "C:" for a host.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(tar, ['-xf', zip, '-C', tool], { stdio: 'inherit' })
}
const headers = join(cache, 'cppwinrt-headers')
execFileSync(generator, ['-in', 'local', '-out', headers], { stdio: 'inherit' })

const slash = (p) => p.replaceAll('\\', '/')
const script = join(cache, 'build-wgc.cmd')
writeFileSync(
  script,
  [
    '@echo off',
    `call "${vcvars}" >nul || exit /b 1`,
    `set "PATH=${cmakeBin};${ninjaBin};%PATH%"`,
    `cmake -S "${source}" -B "${build}" -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_CXX_FLAGS=/I${slash(headers)}" || exit /b 1`,
    `cmake --build "${build}" || exit /b 1`,
  ].join('\r\n'),
)
execFileSync('cmd.exe', ['/d', '/c', script], { stdio: 'inherit' })

mkdirSync(bin, { recursive: true })
for (const exe of ['wgc-capture.exe', 'cursor-sampler.exe']) copyFileSync(join(build, exe), join(bin, exe))
console.log(`Built ${bin}`)
