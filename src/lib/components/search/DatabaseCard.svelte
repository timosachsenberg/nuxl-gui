<script lang="ts">
  // The protein database: the FASTA file, decoys (ProSE's `decoys`) and the cRAP contaminants. Under it, why
  // ProSE cannot search the file (the search does not start), and what ProSE may mishandle in it (notices).
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { chooseFiles } from '$lib/desktop'
  import { CRAP_PROTEINS, searchForm as form } from '$lib/search/form.svelte'
  import { choiceLabel } from '$lib/settings/labels'
  import ChoiceSelect from './ChoiceSelect.svelte'
  import NoticeList from './NoticeList.svelte'

  async function choose() {
    const [path] = await chooseFiles('database')
    if (path !== undefined) await form.setDatabase(path)
  }

  const decoyOptions = $derived(
    (form.entry('decoys')?.validStrings ?? ['auto', 'generate', 'ignore']).map((v) => ({
      value: v,
      label: choiceLabel('decoys', v),
    })),
  )

  const proteins = $derived(form.database?.proteins ?? null)
</script>

<Card.Root size="sm" class="gap-3 rounded-lg shadow-none">
  <Card.Header class="flex items-center">
    <Card.Title class="text-[14px] font-semibold">Protein database</Card.Title>
  </Card.Header>
  <Card.Content class="grid gap-x-4 gap-y-3.5 md:grid-cols-[2fr_1fr_1fr]">
    <div class="grid min-w-0 gap-1">
      <Label for="fasta-file" class="text-xs">FASTA</Label>
      <button
        id="fasta-file"
        type="button"
        aria-describedby="fasta-chosen"
        class="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left dark:bg-input/30 transition-[color,box-shadow] outline-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        title={form.database?.file.path}
        onclick={choose}>
        {#if form.database}
          <span id="fasta-chosen" class="min-w-0 truncate font-mono text-[12.5px]">{form.database.file.name}</span>
          {#if form.database.error}
            <span class="ml-auto shrink-0 text-xs text-destructive" data-testid="fasta-proteins" title={form.database.error}>cannot be read</span>
          {:else if form.database.problem}
            <span class="ml-auto shrink-0 text-xs text-destructive" data-testid="fasta-proteins" title={form.database.problem}>cannot be searched</span>
          {:else}
            <span class="ml-auto shrink-0 text-xs text-muted-foreground" data-testid="fasta-proteins">
              {proteins === null ? 'counting…' : `${proteins.toLocaleString('en-US')} proteins`}
            </span>
          {/if}
        {:else}
          <span id="fasta-chosen" class="text-muted-foreground">Choose a FASTA file…</span>
        {/if}
      </button>
    </div>
    <div class="grid min-w-0 gap-1">
      <Label for="decoys" class="text-xs">Decoys</Label>
      <ChoiceSelect
        id="decoys"
        value={String(form.value('decoys') ?? 'auto')}
        options={decoyOptions}
        onChange={(v) => form.setParam('decoys', v)} />
    </div>
    <div class="grid min-w-0 gap-1">
      <Label for="contaminants" class="text-xs">Contaminants</Label>
      <ChoiceSelect
        id="contaminants"
        value={form.contaminants ? 'crap' : 'none'}
        options={[
          { value: 'crap', label: `Add cRAP (${CRAP_PROTEINS})` },
          { value: 'none', label: 'None' },
        ]}
        onChange={(v) => (form.contaminants = v === 'crap')} />
    </div>
    {#if form.database?.problem || (form.database?.warnings.length ?? 0) > 0}
      <div class="flex flex-col gap-2 md:col-span-3">
        {#if form.database?.problem}
          <p class="text-[12.5px] text-destructive" data-testid="fasta-problem">{form.database.problem} Choose another FASTA file.</p>
        {/if}
        <NoticeList items={(form.database?.warnings ?? []).map((message) => ({ message }))} />
      </div>
    {/if}
  </Card.Content>
</Card.Root>
