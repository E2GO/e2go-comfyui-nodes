"""Ideogram caption assembly; keep styles and LoRA triggers inside JSON."""
import json


def caption(text):
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[-1].rsplit('```', 1)[0].strip()
    if text.startswith('{'):
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise ValueError('Ideogram caption is invalid JSON. Check Enhanced Prompt Preview or select Original.') from exc
        if not isinstance(data.get('high_level_description', ''), str):
            raise ValueError('Ideogram high_level_description must be text.')
    else:
        data = {'high_level_description': text}
    style = data.get('style_description', {})
    if not isinstance(style, dict):
        raise ValueError('Ideogram style_description must be an object.')
    keys = ('aesthetics', 'lighting', 'medium', 'art_style') if 'art_style' in style else ('aesthetics', 'lighting', 'photo', 'medium')
    ordered = {key: style.get(key, '') for key in keys}
    if 'color_palette' in style:
        ordered['color_palette'] = style['color_palette']
    composition = data.get('compositional_deconstruction', {'background': '', 'elements': []})
    if not isinstance(composition, dict) or not isinstance(composition.get('elements', []), list):
        raise ValueError('Ideogram composition must contain an elements list.')
    return {'high_level_description': data.get('high_level_description', ''),
            'style_description': ordered, 'compositional_deconstruction': composition}


def assemble(text, trigger='', prefix='', suffix='', trigger_position='after', style_position='wrap'):
    data = caption(text)
    desc = data['high_level_description']
    data['high_level_description'] = ', '.join(x for x in (
        (trigger, desc) if trigger_position == 'before' else (desc, trigger)) if x and x.strip())
    aesthetics = data['style_description']['aesthetics']
    parts = (prefix, suffix, aesthetics) if style_position == 'before' else (
        (aesthetics, prefix, suffix) if style_position == 'after' else (prefix, aesthetics, suffix))
    data['style_description']['aesthetics'] = ', '.join(x for x in parts if x and x.strip())
    return json.dumps(data, ensure_ascii=False, indent=4)
