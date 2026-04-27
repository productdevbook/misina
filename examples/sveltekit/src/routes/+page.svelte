<script lang="ts">
  import { enhance } from "$app/forms"
  import type { PageData, ActionData } from "./$types"

  let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<h1>Users</h1>
<ul>
  {#each data.users as user (user.id)}
    <li>{user.name} — <code>{user.email}</code></li>
  {/each}
</ul>

<h2>Add a comment</h2>
<form method="post" action="?/comment" use:enhance>
  <textarea name="body" placeholder="Your comment"></textarea>
  <button>Submit</button>
</form>
{#if form?.created}
  <p>Created comment #{form.created.id}</p>
{:else if form?.error}
  <p style="color:tomato">{form.error}</p>
{/if}
