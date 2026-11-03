<script lang="ts">
  // The Spectra card: the mzML files and, from two files on, the experimental design (File ·
  // Condition · Replicate · Fraction; Advanced: Tech. replicate, Fraction group, Sample). Assumed values
  // are greyed; notices go below the table, the summary above it.
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert'
  import XIcon from '@lucide/svelte/icons/x'
  import { tick } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import { parseDesignTsv, writeDesignTsv } from '$lib/design/design-tsv'
  import type { Notice as DesignNotice } from '$lib/design/model'
  import { applyDesign } from '$lib/design/paste'
  import { parseSdrf } from '$lib/design/sdrf'
  import { chooseFiles } from '$lib/desktop'
  import { download } from '$lib/download'
  import { cn } from '$lib/utils'
  import { formatBytes } from '$lib/format/bytes'
  import { searchForm as form } from '$lib/search/form.svelte'
  import DesignCell from './DesignCell.svelte'
  import NoticeList from './NoticeList.svelte'
  import PasteDialog from './PasteDialog.svelte'

  let designInput = $state<HTMLInputElement | null>(null)
  let pasteOpen = $state(false)
  let saveError = $state<string | null>(null)

  const design = $derived(form.design)
  const multi = $derived(form.files.length >= 2)
  const duplicate = $derived(design.notices.find((n) => n.kind === 'duplicateFile') ?? null)

  async function add() {
    const paths = await chooseFiles('spectra')
    if (paths.length > 0) await form.addFiles(paths)
  }

  /** The folder of a path (shown beside the name: two files of one name stay apart). */
  function folderOf(path: string): string {
    const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return at > 0 ? path.slice(0, at) : ''
  }

  /** A design.tsv or SDRF for the files of the table (matched by name). */
  async function loadDesign(input: HTMLInputElement) {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const text = await file.text()
    const header = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase()
    const sdrf = header.includes('comment[data file]') || header.includes('source name')
    const parsed = sdrf ? parseSdrf(text) : parseDesignTsv(text)
    const applied = applyDesign(
      parsed.inputs,
      form.files.map((r) => r.file.name),
    )
    form.applyUpdates(applied.rows)
    const messages = [...parsed.notices.map((n) => n.message), ...applied.notices]
    form.notices.push(...messages.map((m) => `${file.name}: ${m}`))
  }

  async function saveDesign() {
    saveError = null
    try {
      await download('design.tsv', writeDesignTsv(design), 'text/tab-separated-values')
    } catch (e) {
      saveError = String((e as Error)?.message ?? e)
    }
  }

  /** "Change" of a technical-replicate notice: the replicate of the last file concerned, in the Advanced view. */
  async function change(notice: DesignNotice) {
    form.advanced = true
    const row = form.files.findIndex((r) => r.id === notice.rows[notice.rows.length - 1])
    await tick()
    const input = document.querySelector<HTMLInputElement>(`input[data-column="replicate"][data-row="${row}"]`)
    input?.focus()
    input?.select()
  }

  // the design's notices (from two files on), then what adding, pasting, loading or saving could not use
  const notices = $derived([
    ...(multi
      ? design.notices.map((n) => ({
          message: n.message,
          action: n.kind === 'techReplicate' ? { label: 'Change', run: () => change(n) } : undefined,
        }))
      : []),
    ...form.notices.map((message, k) => ({ message, onDismiss: () => form.notices.splice(k, 1) })),
    ...(saveError ? [{ message: saveError, onDismiss: () => (saveError = null) }] : []),
  ])

  /** The files ProSE cannot search (`FileRow.problem`), as the Spectra card lists them. */
  const problems = $derived(form.files.filter((r) => r.problem).map((r) => `${r.problem} Remove it to start the search.`))

  const headerButton = 'h-7 px-2.5 text-xs'
  // the header stays visible over long tables: it sticks to the top of the table's own scroll box
  const th = 'sticky top-0 z-10 bg-card px-2.5 py-2 align-bottom font-medium shadow-[inset_0_-1px_0_var(--border)]'
  // fixed column widths (the File column takes the rest); below this width the box scrolls sideways
  const minWidth = $derived(!multi ? '' : form.advanced ? 'min-w-[1000px]' : 'min-w-[720px]')
</script>

<Card.Root size="sm" class="gap-3 rounded-lg shadow-none">
  <Card.Header class="flex flex-wrap items-center gap-x-2.5 gap-y-2">
    <Card.Title class="text-[14px] font-semibold">Spectra</Card.Title>
    <span class="text-muted-foreground">{form.filesLine}</span>
    <div class="flex-1"></div>
    <div class="flex flex-wrap items-center gap-2">
      {#if multi}
        <Button variant="ghost" size="sm" class={headerButton + ' text-muted-foreground'} onclick={() => (pasteOpen = true)}
          >Paste from spreadsheet</Button>
        <Button variant="outline" size="sm" class={headerButton} onclick={() => designInput?.click()}
          >Load design (SDRF, design.tsv)</Button>
        {#if duplicate}
          <!-- aria-disabled, not disabled: the button stays focusable, so that its tooltip says why -->
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="outline"
                  size="sm"
                  class={headerButton + ' cursor-not-allowed opacity-50 hover:bg-background'}
                  aria-disabled="true"
                  onclick={(e: MouseEvent) => e.preventDefault()}>Save design.tsv</Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content class="max-w-sm" role="tooltip">{duplicate.message}</Tooltip.Content>
          </Tooltip.Root>
        {:else}
          <Button variant="outline" size="sm" class={headerButton} onclick={saveDesign}>Save design.tsv</Button>
        {/if}
      {/if}
      <Button variant="ghost" size="sm" class={headerButton + ' text-muted-foreground'} disabled={form.busy} onclick={() => form.removeAllFiles()}
        >Remove all</Button>
      <Button variant="outline" size="sm" class={headerButton} disabled={form.adding > 0} onclick={add}>Add files</Button>
    </div>
    <input bind:this={designInput} type="file" accept=".tsv,.txt" hidden onchange={(e) => loadDesign(e.currentTarget)} />
  </Card.Header>

  <Card.Content class="flex flex-col gap-2.5">
    {#if multi}
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="inline-flex h-5 items-center rounded-[5px] border bg-muted px-1.5 text-[11.5px] font-medium [font-feature-settings:'case']"
          data-testid="design-summary">{design.summary}</span>
        <span class="text-xs text-muted-foreground">
          An empty Fraction means unfractionated. Empty replicates are numbered in file order. Grey values are assumed.
        </span>
        <div class="flex-1"></div>
        <div class="flex items-center gap-2">
          <Switch id="design-advanced" size="sm" bind:checked={form.advanced} />
          <Label for="design-advanced" class="text-xs font-normal text-muted-foreground">Advanced</Label>
        </div>
      </div>
    {/if}

    <!-- a bounded scroll box: long or wide tables scroll inside it, and it is the sticky header's context -->
    <div class="relative max-h-[70vh] w-full overflow-auto" data-testid="design-scroll">
      <table class={cn('w-full table-fixed border-collapse tabular-nums', minWidth)}>
        <thead>
          <tr class="text-left text-xs text-muted-foreground">
            <th scope="col" class={th}>File</th>
            {#if multi}
              <th scope="col" class="{th} w-[140px]">Condition</th>
              <th scope="col" class="{th} w-[96px]">Replicate</th>
              <th scope="col" class="{th} w-[96px]">Fraction</th>
              {#if form.advanced}
                <th scope="col" class="{th} w-[96px]">Tech. replicate</th>
                <th scope="col" class="{th} w-[80px] text-right" title="The files of one measurement of one sample. OpenMS calls this Fraction_Group."
                  >Fraction group</th>
                <th scope="col" class="{th} w-[150px]" title="Condition + Replicate">Sample</th>
              {/if}
            {/if}
            <th scope="col" class="{th} w-[80px] text-right">Spectra</th>
            <th scope="col" class="{th} w-[76px] text-right">Size</th>
            <th scope="col" class={cn(th, 'w-9 px-1')}><span class="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {#each form.files as file, i (file.id)}
            {@const resolved = design.rows[i]}
            {@const name = file.file.name}
            {@const folder = folderOf(file.file.path)}
            <tr class={cn('border-b last:border-b-0', file.problem && 'bg-destructive/5')} data-problem={file.problem ? '' : undefined}>
              <th scope="row" class="truncate px-2.5 py-1.5 text-left font-normal" title={file.file.path}
                ><span class="font-mono text-[12.5px]">{name}</span>{#if folder}<span
                    class="ml-2 text-xs text-muted-foreground"
                    data-testid="file-folder">{folder}</span
                  >{/if}</th>
              {#if multi && resolved}
                <td class="px-2.5 py-1.5">
                  <DesignCell
                    kind="text"
                    column="condition"
                    row={i}
                    label="Condition of {name}"
                    list="design-conditions"
                    value={file.condition}
                    onChange={(v) => form.setField(file.id, 'condition', v as string | undefined)} />
                </td>
                <td class="px-2.5 py-1.5">
                  <DesignCell
                    kind="int"
                    column="replicate"
                    row={i}
                    label="Replicate of {name}"
                    placeholder={resolved.assumed.replicate ? String(resolved.replicate) : ''}
                    value={file.replicate}
                    onChange={(v) => form.setField(file.id, 'replicate', v as number | undefined)}
                    onInvalid={(t) => form.setInvalidCell(file.id, 'replicate', `Replicate of ${name}`, t)} />
                </td>
                <td class="px-2.5 py-1.5">
                  <DesignCell
                    kind="int"
                    column="fraction"
                    row={i}
                    label="Fraction of {name}"
                    placeholder="–"
                    value={file.fraction}
                    onChange={(v) => form.setField(file.id, 'fraction', v as number | undefined)}
                    onInvalid={(t) => form.setInvalidCell(file.id, 'fraction', `Fraction of ${name}`, t)} />
                </td>
                {#if form.advanced}
                  <td class="px-2.5 py-1.5">
                    <DesignCell
                      kind="int"
                      column="techReplicate"
                      row={i}
                      label="Technical replicate of {name}"
                      placeholder={String(resolved.techReplicate)}
                      value={file.techReplicate}
                      onChange={(v) => form.setField(file.id, 'techReplicate', v as number | undefined)}
                      onInvalid={(t) => form.setInvalidCell(file.id, 'techReplicate', `Technical replicate of ${name}`, t)} />
                  </td>
                  <td class="px-2.5 py-1.5 text-right">{resolved.fractionGroup}</td>
                  {@const sample = design.samples[resolved.sample]?.label ?? ''}
                  <td class="truncate px-2.5 py-1.5" title={sample}>{sample}</td>
                {/if}
              {/if}
              {#if file.problem}
                <td class="px-2.5 py-1.5 text-right text-xs whitespace-nowrap text-destructive" title={file.problem}
                  ><TriangleAlertIcon class="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />unusable</td>
              {:else}
                <td class="px-2.5 py-1.5 text-right">{file.spectra?.toLocaleString('en-US') ?? '–'}</td>
              {/if}
              <td class="px-2.5 py-1.5 text-right whitespace-nowrap">{formatBytes(file.file.size)}</td>
              <td class="px-1 py-1.5 text-center">
                <Button variant="ghost" size="icon-xs" class="text-muted-foreground" aria-label="Remove {name}" onclick={() => form.removeFile(file.id)}
                  ><XIcon /></Button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <datalist id="design-conditions">
      {#each design.conditions as c (c)}<option value={c}></option>{/each}
    </datalist>

    {#if !multi}
      <p class="text-xs text-muted-foreground">
        One file needs no design. Add more files to describe an experiment with conditions, replicates and fractions.
      </p>
    {/if}

    {#if problems.length > 0}
      <!-- what ProSE cannot search: the search does not start until these files are removed -->
      <ul class="flex flex-col gap-1 text-[12.5px] text-destructive" data-testid="file-problems">
        {#each problems as problem, k (k)}<li>{problem}</li>{/each}
      </ul>
    {/if}
    <NoticeList items={notices} />
  </Card.Content>
</Card.Root>

<PasteDialog bind:open={pasteOpen} />
