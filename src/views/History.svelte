<script lang="ts">
  // History: the searches kept on this computer, each a folder of the app's data (the tool's outputs and a
  // record of the settings and the design; the mzML files stay where they are). Open, rename and delete;
  // "Open project…" unpacks a .prose file into History. It stays usable while a search runs, and reads the
  // list again when it is shown. Beside each name: the search's database and, for searches of the same name,
  // what tells them apart (history/details.ts). A folder that is no search (no record, or a name that is not one
  // of a search) is listed with what is wrong, and can be deleted.
  import SaveNotice from '$lib/components/history/SaveNotice.svelte'
  import * as Alert from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import * as Table from '$lib/components/ui/table'
  import { formatBytes } from '$lib/format/bytes'
  import { formatCount } from '$lib/results/display'
  import { history, openFromHistory, openProjectFile, refreshHistory, removeFromHistory, rename } from '$lib/history/history.svelte'
  import type { HistoryEntry } from '$lib/history/history'
  import { distinguishing, entryFacts } from '$lib/history/details'
  import { searchForm } from '$lib/search/form.svelte'
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import { onMount } from 'svelte'

  onMount(() => void refreshHistory())

  /** What went wrong with the last action: open (a stored search or a project file), rename or delete. */
  let problem = $state<{ title: string; text: string } | null>(null)
  /** The search being read from storage, or 'project'. */
  let busy = $state<string | null>(null)
  /** The row being renamed and the name typed so far. */
  let renaming = $state<string | null>(null)
  let draft = $state('')
  let renameInput = $state<HTMLInputElement | null>(null)
  $effect(() => {
    renameInput?.focus()
    renameInput?.select()
  })
  /** The search a Delete asks about. */
  let deleting = $state<HistoryEntry | null>(null)
  let deleteOpen = $state(false)

  const total = $derived(history.entries.reduce((n, e) => n + e.bytes, 0))
  const presetName = (id: string) => searchForm.presets.find((p) => p.id === id)?.name ?? null
  /** The line beside each name: the database, and what tells searches of one name apart (all of it: its tooltip). */
  const details = $derived(distinguishing(history.entries, presetName))

  const message = (e: unknown) => String((e as Error)?.message ?? e)

  const date = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  /** "run_1.mzML", "run_1.mzML, run_2.mzML", "run_1.mzML and 4 more". */
  function filesText(files: string[]): string {
    return files.length <= 2 ? files.join(', ') : `${files[0]} and ${files.length - 1} more`
  }

  async function open(entry: HistoryEntry) {
    problem = null
    busy = entry.id
    try {
      await openFromHistory(entry.id)
    } catch (e) {
      problem = { title: 'Could not open', text: `${entry.name ?? entry.id} could not be opened: ${message(e)}` }
    } finally {
      busy = null
    }
  }

  async function openFile() {
    problem = null
    busy = 'project'
    try {
      await openProjectFile()
    } catch (e) {
      problem = { title: 'Could not open', text: `The project file could not be opened: ${message(e)}` }
    } finally {
      busy = null
    }
  }

  function startRename(entry: HistoryEntry) {
    renaming = entry.id
    draft = entry.name ?? entry.id
  }

  async function commitRename(entry: HistoryEntry) {
    if (renaming !== entry.id) return
    renaming = null
    if (draft.trim() === '' || draft.trim() === entry.name) return
    try {
      await rename(entry.id, draft)
    } catch (e) {
      problem = { title: 'Could not rename', text: `${entry.name ?? entry.id} could not be renamed: ${message(e)}` }
    }
  }

  function askDelete(entry: HistoryEntry) {
    deleting = entry
    deleteOpen = true
  }

  async function confirmDelete() {
    const entry = deleting
    deleteOpen = false
    if (!entry) return
    try {
      await removeFromHistory(entry.id)
    } catch (e) {
      problem = { title: 'Could not delete', text: `${entry.name ?? entry.id} could not be deleted: ${message(e)}` }
    }
  }

  const head = 'h-auto border-b px-3 py-2 font-medium text-muted-foreground'
  const cell = 'border-b px-3 py-2'
</script>

<section data-testid="view-history" class="flex flex-col gap-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="mb-1 text-xl font-semibold tracking-tight">History</h1>
      <p class="text-muted-foreground">
        Finished searches are saved on this computer with their results and the spectra of their PSMs. Your mzML files
        stay where they are.
      </p>
    </div>
    <div>
      <Button variant="outline" size="sm" disabled={busy !== null} onclick={openFile} data-testid="open-project">
        {busy === 'project' ? 'Opening project…' : 'Open project…'}
      </Button>
    </div>
  </div>

  <SaveNotice />

  {#if problem}
    <Alert.Root variant="destructive" class="border-destructive/30" data-testid="history-problem">
      <CircleAlertIcon />
      <Alert.Title class="font-semibold">{problem.title}</Alert.Title>
      <Alert.Description class="text-[12.5px] break-words">
        <p class="text-foreground">{problem.text}</p>
        <div class="mt-2">
          <Button variant="outline" size="sm" class="text-foreground" onclick={() => (problem = null)}>Dismiss</Button>
        </div>
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if history.unavailable}
    <p class="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground" data-testid="history-unavailable">
      {history.unavailable}
    </p>
  {:else if !history.ready}
    <p class="text-xs text-muted-foreground">Reading History…</p>
  {:else if history.entries.length === 0}
    <div class="rounded-lg border border-dashed bg-background px-6 py-10 text-center" data-testid="history-empty">
      <p class="text-sm font-medium">No saved searches yet</p>
      <p class="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
        Finished searches are saved here with their spectra, so you can reopen them later. To open a project file
        (saved with Export › Project, here or on another computer), use Open project above.
      </p>
    </div>
  {:else}
    <!-- a fixed layout: the date, the counts and the buttons keep their width, the name and the files share the
         rest and truncate (at the smallest window the buttons stay in view); in a narrow window the files give their
         room to the name (they are in the name's tooltip) -->
    <div class="rounded-lg border bg-background">
      <Table.Root class="table-fixed text-xs" aria-label="Saved searches" data-testid="history-table">
        <Table.Header>
          <Table.Row class="hover:bg-transparent">
            <Table.Head scope="col" class="{head} text-left">Name</Table.Head>
            <Table.Head scope="col" class="{head} w-[8.75rem] text-left">Finished</Table.Head>
            <Table.Head scope="col" class="{head} text-left max-lg:hidden">Files</Table.Head>
            <Table.Head scope="col" class="{head} w-[4.5rem] text-right" title="Target PSMs that pass the search's PSM FDR">PSMs</Table.Head>
            <Table.Head scope="col" class="{head} w-[4.5rem] text-right" title="Disk space the search takes on this computer">Size</Table.Head>
            <Table.Head scope="col" class="{head} w-[13rem] text-right"><span class="sr-only">Actions</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each history.entries as entry (entry.id)}
            <Table.Row data-testid="history-row" data-id={entry.id}>
              <Table.Cell class="{cell} text-left font-medium">
                {#if renaming === entry.id}
                  <Input
                    class="h-7 text-[13px] md:text-[13px]"
                    aria-label="Name of {entry.name ?? entry.id}"
                    bind:ref={renameInput}
                    bind:value={draft}
                    autocomplete="off"
                    onkeydown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitRename(entry)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        renaming = null
                      }
                    }}
                    onblur={() => commitRename(entry)} />
                {:else}
                  {@const facts = details.get(entry.id) ?? []}
                  <span class="block min-w-0 truncate" title={[entry.name ?? entry.id, ...entry.files].join('\n')} data-column="name"
                    >{entry.name ?? entry.id}</span>
                  {#if facts.length > 0}
                    <span
                      class="mt-0.5 block min-w-0 truncate text-[11px] font-normal text-muted-foreground"
                      title={entryFacts(entry, presetName)
                        .map((f) => f.text)
                        .join('\n')}
                      data-testid="history-row-details">{facts.map((f) => f.text).join(' · ')}</span>
                  {/if}
                  {#if entry.error}
                    <span class="mt-0.5 block text-xs font-normal whitespace-normal text-destructive" data-testid="history-row-error"
                      >{entry.error}</span>
                  {/if}
                {/if}
              </Table.Cell>
              <Table.Cell class="{cell} whitespace-nowrap text-left" data-column="date">
                {#if entry.createdAt}<time datetime={entry.createdAt}>{date(entry.createdAt)}</time>{/if}
              </Table.Cell>
              <Table.Cell class="{cell} text-left max-lg:hidden" data-column="files">
                <span class="block truncate" title={entry.files.join('\n')}>{filesText(entry.files)}</span>
              </Table.Cell>
              <Table.Cell class="{cell} text-right tabular-nums" data-column="psms">{entry.psms === null ? '' : formatCount(entry.psms)}</Table.Cell>
              <Table.Cell class="{cell} text-right whitespace-nowrap tabular-nums" data-column="size">{formatBytes(entry.bytes)}</Table.Cell>
              <Table.Cell class="{cell} text-right whitespace-nowrap">
                <div class="flex justify-end gap-1.5">
                  <Button size="xs" disabled={busy !== null || entry.error !== null} aria-label="Open {entry.name ?? entry.id}" onclick={() => open(entry)}>
                    {busy === entry.id ? 'Opening…' : 'Open'}
                  </Button>
                  <!-- (not while it opens) -->
                  <Button variant="outline" size="xs" disabled={busy === entry.id || entry.error !== null} aria-label="Rename {entry.name ?? entry.id}" onclick={() => startRename(entry)}
                    >Rename</Button>
                  <Button variant="outline" size="xs" disabled={busy === entry.id} aria-label="Delete {entry.name ?? entry.id}" onclick={() => askDelete(entry)}
                    >Delete</Button>
                </div>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
    <p class="text-xs text-muted-foreground" data-testid="history-storage">
      {history.entries.length === 1 ? '1 search takes' : `${history.entries.length} searches take`}
      {formatBytes(total)} on this computer.
    </p>
  {/if}
</section>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="gap-4 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Delete this search?</Dialog.Title>
      <Dialog.Description>
        This removes “{deleting?.name ?? deleting?.id}” and its results from this computer. Your mzML files and any project
        file you saved from it are kept.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (deleteOpen = false)}>Cancel</Button>
      <Button variant="destructive" size="sm" onclick={confirmDelete}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
