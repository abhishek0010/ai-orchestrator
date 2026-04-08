Run the local commit script and then push changes to the remote repository.

Steps:

1. Run `bash ./scripts/local-commit.sh`
2. If committed successfully, run `git push`
3. If push is successful, display a summary of the commit and push status.

Privacy Note: The commit message is generated locally via Ollama. Only the final commit metadata and code are sent to your git remote during push.
