"""Répartition des champs d'une recette et fusion des modifications simultanées.

Recette FAMILIALE = partie commune (espace familial) + partie personnelle de chaque membre
(collection `recipeMeta` de son espace personnel) :
- commune : contenu de la fiche, photos, nutrition, source, astuces ;
- personnelle : favori, note, réalisations, « à essayer », notes personnelles, lien vers sa
  publication « À essayer », provenance d'un envoi.
Le serveur applique lui-même ce tri : une partie personnelle ne peut pas atterrir dans l'espace
familial, même si un téléphone se trompe.

Fusion à trois voies (version d'origine, version du serveur, version envoyée) :
- champs différents → fusion automatique ;
- ingrédients et étapes : élément par élément (identifiant) ; ajouts et retraits conservés ;
- listes simples (étiquettes, galerie) : ajouts et retraits des deux côtés appliqués ;
- même champ ou même élément modifié différemment, ou modifié d'un côté et supprimé de
  l'autre → CONFLIT : la version du serveur reste (ou l'élément modifié est gardé), l'autre est
  conservée et une résolution manuelle est demandée. Rien n'est perdu.
"""
from __future__ import annotations

from typing import Any

PERSONAL_FIELDS = ('favorite', 'toTry', 'rating', 'cookCount', 'lastCookedAt', 'sourcePostId', 'receivedFrom', 'isDemo')
PERSONAL_NOTES = ('modifications', 'mistakes', 'ideas', 'storage', 'reheating')
LOCAL_ONLY = ('space', 'familyInfo')
ID_LISTS = ('ingredients', 'steps')
IGNORED = ('updatedAt',)


def family_part(data: dict) -> dict:
    out = {k: v for k, v in data.items() if k not in PERSONAL_FIELDS and k not in LOCAL_ONLY and k != 'notes'}
    notes = data.get('notes') or {}
    out['notes'] = {'tips': (notes.get('tips') or '') if isinstance(notes, dict) else ''}
    return out


def personal_part(data: dict) -> dict:
    out = {k: data[k] for k in PERSONAL_FIELDS if k in data}
    notes = data.get('notes') or {}
    out['notes'] = {k: ((notes.get(k) or '') if isinstance(notes, dict) else '') for k in PERSONAL_NOTES}
    return out


def join(shared: dict, personal: dict | None) -> dict:
    """Recette complète (déplacement vers l'espace personnel)."""
    p = personal or {}
    out = {**shared, **{k: v for k, v in p.items() if k != 'notes'}}
    out['notes'] = {**{k: '' for k in PERSONAL_NOTES}, **(p.get('notes') or {}), 'tips': (shared.get('notes') or {}).get('tips', '')}
    return out


# ---------------------------------------------------------------------------
# Fusion
# ---------------------------------------------------------------------------

_MISSING = object()


def merge3(base: dict | None, theirs: dict, mine: dict) -> tuple[dict, list[dict]]:
    conflicts: list[dict] = []
    merged = _merge_obj(base, theirs, mine, '', conflicts)
    stamps = [x.get('updatedAt') for x in (theirs, mine) if isinstance(x.get('updatedAt'), (int, float))]
    if stamps:
        merged['updatedAt'] = max(stamps)
    return merged, conflicts


def _merge_obj(base: dict | None, t: dict, m: dict, path: str, conflicts: list) -> dict:
    out: dict = {}
    for k in dict.fromkeys([*t.keys(), *m.keys()]):
        p = f'{path}.{k}' if path else k
        b = base.get(k, _MISSING) if isinstance(base, dict) else _MISSING
        tv, mv = t.get(k, _MISSING), m.get(k, _MISSING)
        if k in IGNORED and not path:
            out[k] = tv if tv is not _MISSING else mv
            continue
        v = _merge_value(k, p, b, tv, mv, base is None, conflicts)
        if v is not _MISSING:
            out[k] = v
    return out


def _merge_value(key: str, path: str, b: Any, t: Any, m: Any, nobase: bool, conflicts: list) -> Any:
    if t == m:
        return t
    if not nobase and b is not _MISSING:
        if t == b:
            return m
        if m == b:
            return t
    if isinstance(t, dict) and isinstance(m, dict):
        return _merge_obj(b if isinstance(b, dict) else (None if nobase else {}), t, m, path, conflicts)
    if isinstance(t, list) and isinstance(m, list):
        bl = b if isinstance(b, list) else None
        if key in ID_LISTS and all(isinstance(x, dict) and 'id' in x for x in [*t, *m]):
            return _merge_id_list(path, None if nobase else bl, t, m, conflicts)
        if all(not isinstance(x, (dict, list)) for x in [*t, *m]):
            return _merge_set_list(None if nobase else bl, t, m)
    if b is _MISSING and not nobase:
        # Champ ajouté des deux côtés avec des valeurs différentes.
        pass
    conflicts.append({'path': path, 'theirs': None if t is _MISSING else t, 'mine': None if m is _MISSING else m})
    return t if t is not _MISSING else m


def _merge_set_list(b: list | None, t: list, m: list) -> list:
    if b is None:  # origine inconnue : on ne retire rien
        return list(dict.fromkeys([*t, *m]))
    removed = (set(b) - set(t)) | (set(b) - set(m))
    return [x for x in dict.fromkeys([*t, *m]) if x not in removed]


def _merge_id_list(path: str, b: list | None, t: list, m: list, conflicts: list) -> list:
    bi = {x['id']: x for x in (b or [])}
    ti = {x['id']: x for x in t}
    mi = {x['id']: x for x in m}
    known = b is not None
    out: dict[str, dict] = {}
    for i in dict.fromkeys([*ti, *mi, *bi]):
        bx, tx, mx = bi.get(i), ti.get(i), mi.get(i)
        p = f'{path}[{i}]'
        if tx is not None and mx is not None:
            if tx == mx:
                out[i] = tx
            elif known and bx is not None and tx == bx:
                out[i] = mx
            elif known and bx is not None and mx == bx:
                out[i] = tx
            else:
                conflicts.append({'path': p, 'theirs': tx, 'mine': mx})
                out[i] = tx
        elif tx is not None:  # absent de la version envoyée
            if not known or bx is None:
                out[i] = tx  # ajouté de l'autre côté
            elif tx != bx:  # supprimé ici, modifié ailleurs → gardé, à revoir
                conflicts.append({'path': p, 'theirs': tx, 'mine': None})
                out[i] = tx
        elif mx is not None:  # absent du serveur
            if not known or bx is None:
                out[i] = mx  # ajouté ici
            elif mx != bx:  # supprimé ailleurs, modifié ici → gardé, à revoir
                conflicts.append({'path': p, 'theirs': None, 'mine': mx})
                out[i] = mx
    t_ids, m_ids = [x['id'] for x in t], [x['id'] for x in m]
    primary, secondary = (m_ids, t_ids) if known and t_ids == [x['id'] for x in b] else (t_ids, m_ids)
    order = [i for i in primary if i in out] + [i for i in secondary if i in out and i not in primary]
    order += [i for i in out if i not in order]
    return [out[i] for i in order]
