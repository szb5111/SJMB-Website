#!/usr/bin/env python3
"""Guard against a bug that bit three of the four scene files:

A backtick inside a GLSL comment terminates the JavaScript template literal that
holds the shader, producing a SyntaxError far from the real cause. Scan each
`/* glsl */` template literal and report any backtick inside it.
"""
import re, sys, pathlib
bad = 0
for f in sorted(pathlib.Path(__file__).parent.parent.glob('src/gl/*.js')):
    s = f.read_text()
    # every template literal opened right after a /* glsl */ marker
    for m in re.finditer(r'/\*\s*glsl\s*\*/`', s):
        start = m.end()
        end = s.find('`', start)
        if end < 0:
            print(f"{f.name}: unterminated glsl literal at offset {start}"); bad += 1; continue
        body = s[start:end]
        # a stray backtick would have ended it early — detect by checking the
        # closing context looks like a real terminator (`; or `,  or `)
        tail = s[end:end+3]
        if not re.match(r'`\s*[;,)\n]', tail):
            line = s[:end].count('\n') + 1
            print(f"{f.name}:{line}: glsl literal ends at a backtick that is not a terminator "
                  f"— a stray backtick in a shader comment?"); bad += 1
print("stray-backtick check:", "FAIL" if bad else "clean")
sys.exit(1 if bad else 0)
