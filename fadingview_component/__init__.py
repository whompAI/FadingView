from __future__ import annotations

from pathlib import Path
import streamlit.components.v1 as components

_BUILD_DIR = Path(__file__).parent / "frontend" / "build"

_component = components.declare_component("fadingview_component", path=str(_BUILD_DIR))


def render_fadingview(data: dict, key: str | None = None, default=None, height: int | None = 0):
    return _component(data=data, key=key, default=default, height=height)
