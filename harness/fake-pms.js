'use strict';

// PMS simulado para el harness -- Bloque B.
//
// Reproduce los CONTRATOS de las read tools reales
// (conversational-tools.service.js en pms-lite), no su implementacion. Sirve
// para probar el lazo de tools, la seleccion de herramienta y los argumentos
// sin base de datos y sin red.
//
// Las reglas de ambiguedad son las MISMAS que las del servicio real: 210/404
// tienen balcon, 1208 tiene aire. Si el fake fuera mas permisivo que el real,
// el harness daria verdes que produccion no daria.

const GOVERNED = ['LF-210', 'LF-404', 'LF-510', 'LF-904', 'LF-1109', 'LF-1208'];
const ATTRS = {
  'LF-210': { balcony: true, air_conditioning: false },
  'LF-404': { balcony: true, air_conditioning: false },
  'LF-510': { balcony: false, air_conditioning: false },
  'LF-904': { balcony: true, air_conditioning: false },
  'LF-1109': { balcony: false, air_conditioning: false },
  'LF-1208': { balcony: false, air_conditioning: true }
};

const ok = (data, source = null) => ({ status: 'ok', data, missing: [], reason: null, source });
const needs = (missing, reason) => ({ status: 'needs_clarification', data: null, missing, reason, source: null });
const unavailable = (reason, data = null) => ({ status: 'unavailable', data, missing: [], reason, source: null });

function createFakePms({ proposalSnapshot = null, calls = [] } = {}) {
  async function execute(name, args) {
    calls.push({ name, args });

    switch (name) {
      case 'resolve_apartment_reference': {
        const raw = String(args.raw || '').toLowerCase();
        const canonical = raw.match(/\blf-(\d{3,4})\b/);
        if (canonical) {
          const code = `LF-${canonical[1]}`;
          return GOVERNED.includes(code) ? ok({ apartment_code: code, resolved_by: 'canonical_code' })
            : unavailable('apartment_not_in_scope');
        }
        if (args.hint_type === 'number_fragment' || /\b\d{3,4}\b/.test(raw)) {
          const fragment = String(args.hint_value || (raw.match(/\b(\d{3,4})\b/) || [])[1] || '');
          const matches = GOVERNED.filter((c) => c.slice(3) === fragment);
          if (matches.length === 1) return ok({ apartment_code: matches[0], resolved_by: 'number_fragment' });
          if (matches.length > 1) return needs(['apartment'], `ambiguous_number_fragment:${fragment}`);
          return unavailable('number_fragment_not_in_scope', { fragment });
        }
        if (args.hint_type === 'attribute' && args.hint_value) {
          const attribute = String(args.hint_value).toLowerCase().replace(/\s+/g, '_');
          const matches = GOVERNED.filter((c) => ATTRS[c] && ATTRS[c][attribute] === true);
          if (matches.length === 1) return ok({ apartment_code: matches[0], resolved_by: `attribute:${attribute}` });
          if (matches.length > 1) return needs(['apartment'], `ambiguous_attribute:${attribute}`);
          return needs(['apartment'], `no_apartment_with_attribute:${attribute}`);
        }
        if (args.hint_type === 'anaphora') {
          const codes = [...new Set((proposalSnapshot?.proposals || []).map((p) => p.apartment_code))];
          if (codes.length === 1) return ok({ apartment_code: codes[0], resolved_by: 'anaphora_single_proposal' });
          const current = proposalSnapshot?.selected_code || null;
          const others = codes.filter((c) => c !== current);
          if (/\botro\b/.test(raw) && current && others.length === 1) {
            return ok({ apartment_code: others[0], resolved_by: 'anaphora_the_other' });
          }
          return needs(['apartment'], codes.length ? 'ambiguous_anaphora' : 'no_proposal_to_refer_to');
        }
        return needs(['apartment'], 'unresolvable_reference');
      }

      case 'check_availability': {
        const missing = [];
        if (!args.arrival_date) missing.push('check_in');
        if (!args.nights) missing.push('check_out_or_nights');
        if (missing.length) return needs(missing, 'availability_requires_exact_start_date');
        return ok({ available: [{ apartment_code: args.apartment_code || 'LF-210', nights: args.nights }] });
      }

      case 'quote_stay': {
        if (!args.nights) return needs(['check_out_or_nights'], 'quote_requires_duration');
        // Escalones reales de duration_tier_v1.
        const monthly = args.nights >= 360 ? 2800000 : args.nights >= 180 ? 2950000
          : args.nights >= 90 ? 3100000 : 3300000;
        return ok({ nights: args.nights, price: { monthly_cop: monthly }, requires_policy: args.nights >= 180 });
      }

      case 'get_public_apartment_attributes': {
        const code = args.apartment_code;
        if (!GOVERNED.includes(code)) return unavailable('apartment_not_in_scope');
        return ok({ apartment_code: code, public_attributes: ATTRS[code] || {} });
      }

      case 'get_policy':
        return args.policy_key === 'duration_tier_v1'
          ? ok({ policy_key: args.policy_key, config: { tiers: [30, 90, 180, 360] } })
          : needs([], `policy_not_published:${args.policy_key}`);

      case 'search_commercial_knowledge': {
        const known = new Set(['parking', 'check_in_out_schedule', 'location']);
        const resolved = (args.topics || []).filter((t) => known.has(t));
        const unresolved = (args.topics || []).filter((t) => !known.has(t));
        if (!resolved.length) return needs(unresolved, 'no_approved_source_for_topics');
        return ok({ resolved, unresolved });
      }

      case 'get_current_proposal':
        return proposalSnapshot ? ok(proposalSnapshot) : needs([], 'no_current_proposal');

      case 'request_human_review':
        return ok({ registered: true, category: args.category });

      default:
        return { status: 'error', data: null, missing: [], reason: `unknown_tool:${name}`, source: null };
    }
  }

  return { execute, calls };
}

module.exports = { createFakePms, GOVERNED, ATTRS };
