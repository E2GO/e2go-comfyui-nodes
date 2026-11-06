"""Compile Powder Canvas regions into each model's native prompt format."""
import json
import math
import re


def visible_text(region):
    if region.get('text', '').strip():
        return region['text']
    matches = re.findall(r'"([^"\r\n]+)"|«([^»\r\n]+)»|“([^”\r\n]+)”|‘([^’\r\n]+)’|(?<!\w)\'([^\'\r\n]+)\'(?!\w)', region.get('caption', ''))
    values = [next(v for v in groups if v).strip() for groups in matches]
    values = [v for v in values if v]
    return values[0] if len(values) == 1 else ''


def compile_layout(config, prompt='', width=None, height=None):
    d = json.loads(config) if isinstance(config, str) else config
    if d and not isinstance(d, dict):
        raise ValueError('Canvas Layout document must be an object.')
    if not d or not d.get('enabled'):
        return None
    w, h = d.get('width', 1024), d.get('height', 1024)
    if any(not isinstance(v, int) or not 16 <= v <= 16384 for v in (w, h)):
        raise ValueError('Canvas Layout: invalid canvas dimensions.')
    if (width and width != w) or (height and height != h):
        raise ValueError(f'Canvas Layout is {w}x{h}, generation is {width}x{height}. Use Match generation size in Layout.')
    target = d.get('target', 'ideogram4')
    if target not in ('ideogram4', 'moss', 'flux3'):
        raise ValueError(f'Canvas Layout: unsupported target {target!r}.')
    if target == 'moss' and (w % 16 or h % 16):
        raise ValueError('MOSS Layout dimensions must be multiples of 16.')
    layout_only = d.get('promptSource') == 'layout_only'
    if layout_only:
        prompt = ''
    scene = d.get('scene', '').strip()
    # A structured enhancer's whole JSON must never become the scene's literal text.
    inherited_style = {}
    if prompt.strip().startswith('{'):
        parsed = json.loads(prompt)
        inherited_style = parsed.get('style_description', {})
        prompt = parsed.get('high_level_description', parsed.get('summary', {}).get('caption', prompt))
    if layout_only and not scene:
        scene = ' '.join(r.get('caption', '').strip() for r in d.get('regions', [])
                         if isinstance(r, dict) and r.get('enabled') is not False)
    scene = scene or prompt
    if not scene.strip():
        raise ValueError('Canvas Layout: describe the scene or connect a prompt.')
    if not isinstance(d.get('regions', []), list) or not isinstance(d.get('style', {}), dict):
        raise ValueError('Canvas Layout: regions must be an array and style must be an object.')
    regions = []
    for i, r in enumerate(d.get('regions', [])):
        if not isinstance(r, dict):
            raise ValueError(f'Canvas Layout region {i + 1}: expected an object.')
        if r.get('enabled') is False:
            continue
        if r.get('label') not in ('object', 'character', 'text'):
            raise ValueError(f'Canvas Layout region {i + 1}: unsupported type.')
        rect = r.get('rect', [])
        if not isinstance(rect, (list, tuple)) or len(rect) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in rect):
            raise ValueError(f'Canvas Layout region {i + 1}: invalid rectangle.')
        x, y, rw, rh = rect
        if x < 0 or y < 0 or rw <= 0 or rh <= 0 or x + rw > 1.000000001 or y + rh > 1.000000001:
            raise ValueError(f'Canvas Layout region {i + 1}: rectangle is outside the canvas.')
        if not r.get('caption', '').strip():
            raise ValueError(f'Canvas Layout region {i + 1}: fill its Region prompt (Typography & appearance for text regions).')
        if r.get('label') == 'text':
            r = {**r, 'text': visible_text(r)}
            if not r['text']:
                raise ValueError(f'Canvas Layout region {i + 1}: fill "Exact visible text" or put one exact inscription in quotes in Typography & appearance.')
        regions.append(r)
    if not regions:
        raise ValueError('Canvas Layout: add a region or turn off Use layout.')
    if target == 'flux3':
        rows, descriptions = [], []
        used_ids = set()
        reserved_ids = {r['id'] for r in regions if isinstance(r.get('id'), str)
                        and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', r['id'])}
        for i, r in enumerate(regions):
            identity = r.get('id', '')
            if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', identity) or identity in used_ids:
                identity = f"{r['label']}_{i + 1}"
                while identity in reserved_ids or identity in used_ids:
                    identity += "_"
            used_ids.add(identity)
            desc = r['caption']
            if r.get('palette'):
                desc += ' Colors: ' + ', '.join(r['palette']) + '.'
            if r['label'] == 'text':
                desc += ' Visible text: ' + json.dumps(r['text'], ensure_ascii=False) + '.'
            x, y, rw, rh = r['rect']
            rows.append({'id': identity, 'bbox': [math.floor(v * 1000 + 0.5) for v in (y, x, y + rh, x + rw)], 'desc': desc})
            descriptions.append(f'<{identity}> {desc}')
        scene = split_flux3(scene)[0]
        palette = 'Palette: ' + ', '.join(d['palette']) + '.' if d.get('palette') else ''
        prose = '\n'.join(v for v in [scene, d.get('background', ''), *d.get('style', {}).values(), palette, *descriptions] if isinstance(v, str) and v)
        return prose + ' ' + json.dumps(rows, ensure_ascii=False)
    if target == 'moss':
        summary = {}
        if d.get('meta'):
            summary['meta'] = d['meta']
        summary['canvas'] = d.get('canvas', 'single')
        summary['caption'] = '\n'.join(x for x in (scene, d.get('background', '')) if x)
        if d.get('palette'):
            summary['palette'] = d['palette']
        items = []
        for r in regions:
            item = {'label': r['label'], 'caption': r['caption']}
            if r['label'] == 'text':
                item['text'] = r['text']
            for key in ('tags', 'palette'):
                if r.get(key):
                    item[key] = r[key]
            x, y, rw, rh = r['rect']
            item['bbox'] = [math.floor(round(y * h, 9)) - h // 2, math.floor(round(x * w, 9)) - w // 2,
                            math.ceil(round((y + rh) * h, 9)) - h // 2, math.ceil(round((x + rw) * w, 9)) - w // 2]
            items.append(item)
        data = {'summary': summary, 'items': items, 'bbox_coord_space': 'abs_centralized', 'bbox_format': 'yxyx'}
        return json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    style = {**inherited_style, **{k: v for k, v in d.get('style', {}).items() if v}}
    if d.get('palette'):
        style['color_palette'] = d['palette']
    elements = []
    for r in regions:
        x, y, rw, rh = r['rect']
        el = {'type': 'text' if r['label'] == 'text' else 'obj',
              'bbox': [math.floor(v * 1000 + 0.5) for v in (y, x, y + rh, x + rw)]}
        if el['type'] == 'text':
            el['text'] = r['text']
        el['desc'] = r['caption']
        if r.get('palette'):
            el['color_palette'] = r['palette']
        elements.append(el)
    return json.dumps({'high_level_description': scene, 'style_description': style,
                       'compositional_deconstruction': {'background': d.get('background', ''), 'elements': elements}}, ensure_ascii=False)


def assemble_moss(prompt, trigger, prefix, suffix, trigger_position, style_position='wrap'):
    from .powder_conditioner import _assemble_prompt
    data = json.loads(prompt)
    data['summary']['caption'] = _assemble_prompt(data['summary']['caption'], trigger, prefix, suffix, trigger_position, style_position)
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'))


def split_flux3(prompt):
    """Find a trailing box table without mistaking brackets inside descriptions for it."""
    for i in range(len(prompt) - 1, -1, -1):
        if prompt[i] != '[':
            continue
        try:
            rows = json.loads(prompt[i:])
        except json.JSONDecodeError:
            continue
        if isinstance(rows, list) and rows and all(isinstance(r, dict) and 'id' in r and 'bbox' in r for r in rows):
            return prompt[:i].rstrip(), rows
    return prompt, None


def assemble_flux3(prompt, trigger, prefix, suffix, trigger_position, style_position='wrap'):
    from .powder_conditioner import _assemble_prompt
    prose, rows = split_flux3(prompt)
    prose = _assemble_prompt(prose, trigger, prefix, suffix, trigger_position, style_position)
    return prose + ' ' + json.dumps(rows, ensure_ascii=False) if rows is not None else prose
