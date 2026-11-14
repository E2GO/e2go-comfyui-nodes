"""Route the source to a prompt enhancer only for an image-editing task."""

from .powder_inpaint import MODES


def consumer_mode(graph, unique_id):
    """Find image-conditioning consumers downstream of this context node.

    Do not inspect tensors or execute the graph. Reject ambiguous consumers:
    sharing a context between a Generate and an Edit branch is unsafe.
    """
    if not isinstance(graph, dict) or str(unique_id) not in graph:
        raise ValueError('Enhancer Context needs a workflow connected to Powder Image Conditioning.')
    reachable = {str(unique_id)}
    visited = set(reachable)
    modes = set()
    pending = True
    while pending:
        pending = False
        for node_id, node in graph.items():
            if str(node_id) in visited or not isinstance(node, dict):
                continue
            inputs = node.get('inputs') or {}
            if not any(isinstance(v, list) and len(v) == 2 and
                       isinstance(v[0], (str, int)) and str(v[0]) in reachable
                       for v in inputs.values()):
                continue
            visited.add(str(node_id))
            pending = True
            if node.get('class_type') == 'PowderImageConditioning':
                mode = inputs.get('mode', 'Repaint')
                if not isinstance(mode, str):
                    raise ValueError('Enhancer Context: use the mode widget on Image Conditioning; linked modes are not supported.')
                if mode not in MODES:
                    raise ValueError(f'Enhancer Context: unsupported image-conditioning mode {mode!r}.')
                modes.add(mode)
            else:
                reachable.add(str(node_id))
    if len(modes) != 1:
        raise ValueError('Enhancer Context needs exactly one downstream Image Conditioning mode. Use a separate context for each task.')
    return next(iter(modes))


def stamp_enhancer_modes(graph):
    if not isinstance(graph, dict):
        return
    for node_id, node in graph.items():
        if isinstance(node, dict) and node.get('class_type') == 'PowderEnhancerContext':
            try:
                mode = consumer_mode(graph, node_id)
            except ValueError:
                mode = ''  # Execution reports an invalid graph, not the prompt hook.
            node.setdefault('inputs', {})['consumer_mode'] = mode


class PowderEnhancerContext:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            'required': {},
            'optional': {'consumer_mode': ('STRING', {'default': ''}),
                         'image': ('IMAGE', {'lazy': True,
                'tooltip': 'Source image for Edit. Generate, Repaint and Repair send no image to the enhancer.'})},
            'hidden': {'graph': 'PROMPT', 'unique_id': 'UNIQUE_ID'},
        }

    RETURN_TYPES = ('IMAGE',)
    RETURN_NAMES = ('enhancer_image',)
    FUNCTION = 'route'
    CATEGORY = 'e2go'
    DESCRIPTION = ('Connect Canvas image here and the output to the prompt enhancer image input. '
                   'The downstream Powder Image Conditioning mode controls whether the source is shown. '
                   'Edit sees the source; Generate, Repaint and Repair use text only.')

    @classmethod
    def IS_CHANGED(cls, graph=None, unique_id=None, **kwargs):
        # The mode is downstream, hence absent from the default ancestor cache
        # signature. Explicitly include it before execution/cache lookup.
        return kwargs.get('consumer_mode') or (consumer_mode(graph, unique_id) if graph else '')

    def check_lazy_status(self, image=None, graph=None, unique_id=None, **kwargs):
        mode = consumer_mode(graph, unique_id)
        connected = 'image' in (graph[str(unique_id)].get('inputs') or {})
        return ['image'] if mode.startswith('Edit') and connected and image is None else []

    def route(self, image=None, graph=None, unique_id=None, **kwargs):
        mode = consumer_mode(graph, unique_id)
        if not mode.startswith('Edit'):
            return (None,)
        if image is None or getattr(image, '_e2go_empty_canvas', False):
            raise ValueError('Load a source image in Canvas before enhancing an Edit prompt.')
        return (image,)


NODE_CLASS_MAPPINGS = {'PowderEnhancerContext': PowderEnhancerContext}
NODE_DISPLAY_NAME_MAPPINGS = {'PowderEnhancerContext': 'Powder Enhancer Context'}
