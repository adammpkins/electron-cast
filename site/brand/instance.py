# Cuts static instances of the self-hosted variable fonts so the wordmark can be outlined to SVG paths.
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src, out, *axes = sys.argv[1:]
font = TTFont(src)
font = instancer.instantiateVariableFont(font, {a.split("=")[0]: float(a.split("=")[1]) for a in axes})
font.flavor = None
font.save(out)
