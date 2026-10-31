// UVE addition (not part of OpenScreen): lets the helpers build with Visual
// Studio 2019 Build Tools and Windows SDK 10.0.19041, which predate two things
// OpenScreen's code uses. Force-included into every source file by CMakeLists.txt.
#pragma once

// Windows 11 SDK constant; the value is documented and stable.
#ifndef PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
#define PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION 0x4
#endif

// The 19041 GDI+ headers call unqualified min/max, which NOMINMAX removes.
#ifdef __cplusplus
#include <algorithm>
namespace Gdiplus {
using std::max;
using std::min;
}
#endif
