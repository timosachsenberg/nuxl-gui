// The cross-linked residues of a protein as a script for a molecular viewer: ChimeraX (.cxc) or PyMOL (.pml). The
// script opens the protein's AlphaFold DB model when its accession is UniProt's (the viewer fetches it, not the app),
// shows it as a grey cartoon, and shows, colours (by PSMs) and labels the sites. Each label starts with the structure's
// own residue ("LYS 123"), so that a structure numbered otherwise than the FASTA shows; the PyMOL script also checks
// the residues and says so in its log. Without a UniProt accession (or for an isoform, whose model AlphaFold DB may
// not have) the user opens a structure first and then runs the script, which marks the residues of every open model.

import { adductLabel } from '../format/peptide'
import type { CrossLinkedSite } from './protein'

export type StructureViewer = 'chimerax' | 'pymol'

/** What a script needs to know of the protein and its search. */
export type StructureInput = {
  /** The protein's accession as the FASTA has it ("sp|P02768|ALBU_HUMAN", "CON__P02768", "Cas7"). */
  accession: string
  /** Its description (from the FASTA). */
  description: string
  /** Residues of its sequence; 0: unknown. */
  length: number
  /** Its cross-linked residues (`crossLinkedSites`), ascending. */
  sites: CrossLinkedSite[]
  /** The search's cross-link FDR (0.01: 1 %). */
  xlFdr: number
  /** The result's name (`exportName`). */
  result: string
}

// UniProt's accession format (https://www.uniprot.org/help/accession_numbers), with an isoform's "-2"
const uniprotPattern = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-(\d+))?$/

/**
 * The UniProt accession in a FASTA accession: the middle field of "sp|P02768|ALBU_HUMAN" or "tr|…|…" (not of a decoy's
 * "DECOY_sp|…"), or the whole of
 * a bare one ("P02768", "P02768-2"), without a contaminant's "CON__"; null for anything else (RefSeq, Ensembl, "Cas7").
 * `isoform`: it names an isoform ("-2"), whose numbering may differ from the canonical sequence's.
 */
export function uniprotAccession(accession: string): { id: string; isoform: boolean } | null {
  let rest = accession.trim().replace(/^CON__/, '')
  const parts = rest.split('|')
  if (parts.length === 3) {
    if (parts[0] !== 'sp' && parts[0] !== 'tr') return null
    rest = parts[1]
  }
  const match = uniprotPattern.exec(rest)
  return match ? { id: rest, isoform: match[2] !== undefined } : null
}

/** The scripts' file name without extension: "<result>_<accession>_xl-sites". */
export function structureFileStem(input: StructureInput): string {
  const id = uniprotAccession(input.accession)?.id ?? input.accession.replace(/^CON__/, '').split('|').filter(Boolean)[0] ?? 'protein'
  return `${input.result}_${id.replace(/[^A-Za-z0-9._-]+/g, '_')}_xl-sites`
}

/** The script for `viewer`. */
export function structureScript(viewer: StructureViewer, input: StructureInput): string {
  return viewer === 'chimerax' ? chimeraxScript(input) : pymolScript(input)
}

// ---- shared parts

/** Light to dark violet (the app's colour of a cross-linked residue): few to many PSMs. */
const ramp = ['#c4b5fd', '#a78bfa', '#7c3aed', '#4c1d95']

/** The colour (index into `ramp`) of a site with `psms` PSMs, the protein's sites having at most `max`. */
function shade(psms: number, max: number): number {
  return max > 1 ? Math.round(((psms - 1) / (max - 1)) * (ramp.length - 1)) : ramp.length - 2
}

const subscripts = /[₀-₉]/g
/** An adduct in plain ASCII, as viewers' labels show it: "U-H3PO4" (adductLabel without subscripts). */
const plainAdduct = (adduct: string) => adductLabel(adduct).replace(subscripts, (d) => String(d.charCodeAt(0) - 0x2080)) || 'no adduct'

/** "U-H3PO4 x3 / UU-H2O x1": no comma nor semicolon, which PyMOL's command line would split at. */
const adductsText = (site: CrossLinkedSite) => site.adducts.map((a) => `${plainAdduct(a.adduct)} x${a.psms}`).join(' / ')

/** One line of text for a comment: no line breaks. */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim()

/** 1-based residue number of a site. */
const number = (site: CrossLinkedSite) => site.position + 1

const percent = (fraction: number) => `${+(fraction * 100).toFixed(2)} %`

/** The header both scripts share: what the sites are, their table, the colours and how to read the labels. */
function header(input: StructureInput, viewer: string): string[] {
  const max = Math.max(...input.sites.map((s) => s.psms))
  const name = [input.accession, oneLine(input.description)].filter(Boolean).join(' ')
  const lines = [
    `NuXL: the cross-linked residues of ${name}, for ${viewer}`,
    `Result: ${input.result}. Sites: where localized cross-link PSMs at the search's cross-link FDR (${percent(input.xlFdr)}) put`,
    `the nucleic acid. Residue numbers count from 1 in the protein's sequence in the search's FASTA` +
      (input.length > 0 ? ` (${input.length} residues).` : ' (its sequence is unknown).'),
    '',
    'site      PSMs  best localization score  adducts (PSMs)',
    ...input.sites.map(
      (s) =>
        `${`${s.residue}${number(s)}`.padEnd(10)}${String(s.psms).padEnd(6)}${(s.score === s.score ? s.score.toFixed(2) : '-').padEnd(25)}${adductsText(s)}`,
    ),
    '',
    max > 1 ? `Colour: the number of PSMs, light violet (1) to dark violet (${max}).` : 'Colour: violet.',
    'Each label starts with the structure\'s own residue and number ("LYS 123"). If that is not the residue in the',
    'table (K123), the structure is numbered otherwise than the FASTA (another isoform, sequence version or',
    'construct): the colours are then on the wrong residues.',
  ]
  return lines
}

/** How the script gets the structure: the AlphaFold DB model, or the user opens one. */
function source(input: StructureInput): { fetch: string | null; note: string[] } {
  const uniprot = uniprotAccession(input.accession)
  if (uniprot && !uniprot.isoform)
    return {
      fetch: uniprot.id,
      note: [
        `The structure: the AlphaFold DB model of ${uniprot.id} (alphafold.ebi.ac.uk, CC-BY 4.0), numbered as UniProt's`,
        `canonical sequence of ${uniprot.id}. Running the script downloads it, which sends the accession to EBI.`,
        'AlphaFold DB has no models of proteins longer than 2700 residues on its website. For a structure of your own',
        '(e.g. from the PDB), delete the lines that fetch the model, open the structure, then run this script.',
      ],
    }
  const why = uniprot
    ? `${uniprot.id} is an isoform: AlphaFold DB may have no model of it, and the canonical sequence's model is numbered otherwise.`
    : `${input.accession} is not a UniProt accession, so there is no AlphaFold DB model to fetch.`
  return {
    fetch: null,
    note: [why, 'Open a structure of the protein first, numbered as the FASTA\'s sequence, then run this script.', 'It marks the residues of every open model.'],
  }
}

// ---- ChimeraX

/** A label's text for ChimeraX: its `{0.…}` fields are the residue's; other braces doubled, no double quotes. */
const chimeraxText = (text: string) => text.replace(/[{}]/g, (b) => b + b).replace(/"/g, "'")

function chimeraxScript(input: StructureInput): string {
  const { fetch, note } = source(input)
  const max = Math.max(...input.sites.map((s) => s.psms))
  const all = `:${input.sites.map(number).join(',')}`
  const lines = [...header(input, 'ChimeraX (open this file in ChimeraX)'), '', ...note].map((l) => (l ? `# ${l}` : '#'))
  if (fetch !== null) lines.push(`alphafold fetch ${fetch}`)
  lines.push(
    '# the confidence (pLDDT) colours instead of grey: color bfactor palette alphafold',
    'cartoon',
    'color lightgray',
    `show ${all} atoms`,
    `style ${all} ball`,
  )
  for (const s of input.sites) lines.push(`color :${number(s)} ${ramp[shade(s.psms, max)]}`)
  for (const s of input.sites) lines.push(`label :${number(s)} text "{0.name} {0.number}: ${chimeraxText(adductsText(s))}"`)
  lines.push(`view ${all}`)
  return lines.join('\n') + '\n'
}

// ---- PyMOL

/** Text inside a PyMOL label's double-quoted string: no quotes, backslashes, commas or semicolons. */
const pymolText = (text: string) => text.replace(/["\\]/g, "'").replace(/[,;]/g, ' ')

/** The PyMOL colour name of ramp shade `k`. */
const pymolColour = (k: number) => `nuxl_xl_${k + 1}`

function pymolScript(input: StructureInput): string {
  const { fetch, note } = source(input)
  const max = Math.max(...input.sites.map((s) => s.psms))
  const all = `resi ${input.sites.map(number).join('+')}`
  const lines = [...header(input, 'PyMOL (File > Run Script, or: run this.pml)'), '', ...note].map((l) => (l ? `# ${l}` : '#'))
  if (fetch !== null) {
    const name = `AF-${fetch}`
    lines.push(
      '# fetch the model: the file that AlphaFold DB names for the accession, else its file of the newest version',
      'python',
      'import json, urllib.request',
      'from pymol import cmd',
      'def _nuxl_fetch(accession, name):',
      '    urls = []',
      '    try:',
      '        with urllib.request.urlopen("https://alphafold.ebi.ac.uk/api/prediction/" + accession, timeout=30) as answer:',
      '            urls += [e["cifUrl"] for e in json.load(answer) if isinstance(e, dict) and e.get("cifUrl")]',
      '    except Exception as e:',
      '        print("NuXL: AlphaFold DB did not name the model of %s (%s)" % (accession, e))',
      '    urls += ["https://alphafold.ebi.ac.uk/files/AF-%s-F1-model_v%d.cif" % (accession, v) for v in range(9, 3, -1)]',
      '    for url in urls:',
      '        try:',
      '            cmd.load(url, name)',
      '        except Exception:',
      '            continue',
      '        if cmd.count_atoms(name) > 0:',
      '            print("NuXL: loaded " + url)',
      '            return',
      '    print("NuXL: no AlphaFold DB model of %s could be loaded: open a structure of it, then run this script without this first python block" % accession)',
      `_nuxl_fetch("${fetch}", "${name}")`,
      'python end',
    )
  }
  lines.push('hide everything', 'show cartoon', 'color grey80')
  ramp.forEach((hex, k) => {
    const rgb = [1, 3, 5].map((i) => +(parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3))
    lines.push(`set_color ${pymolColour(k)}, [${rgb.join(', ')}]`)
  })
  lines.push(`select nuxl_xl_sites, polymer.protein and ${all}`, 'show sticks, nuxl_xl_sites and not name N+C+O', 'set label_size, 20')
  for (const s of input.sites) lines.push(`color ${pymolColour(shade(s.psms, max))}, polymer.protein and resi ${number(s)}`)
  for (const s of input.sites)
    lines.push(`label polymer.protein and resi ${number(s)} and name CA, resn + " " + resi + ": ${pymolText(adductsText(s))}"`)
  lines.push(
    '# check that the structure has the sites\' residues at their numbers',
    'python',
    'from pymol import cmd',
    'def _nuxl_check(sites):',
    '    three = {"ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C", "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I",',
    '             "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P", "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",',
    '             "SEC": "U", "PYL": "O"}',
    '    wrong = []',
    '    for resi, residue in sites:',
    '        names = []',
    '        cmd.iterate("polymer.protein and resi %d and name CA" % resi, "names.append(resn)", space={"names": names})',
    '        if residue not in {three.get(n.upper(), "?") for n in names}:',
    '            wrong.append("%s%d (structure: %s)" % (residue, resi, "/".join(sorted(set(names))) or "none"))',
    '    if wrong:',
    '        print("NuXL: WARNING: the structure does not have these sites\' residues, so it is numbered otherwise than the FASTA: " + ", ".join(wrong))',
    '    else:',
    '        print("NuXL: the structure has the residues of all %d sites" % len(sites))',
    `_nuxl_check([${input.sites.map((s) => `(${number(s)}, "${s.residue.replace(/[^A-Z]/g, 'X')}")`).join(', ')}])`,
    'python end',
    'zoom nuxl_xl_sites, 8',
  )
  return lines.join('\n') + '\n'
}
