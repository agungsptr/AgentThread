.PHONY: restart status

restart:
	@echo "$(TASK) $$(date +%s)" >> .stack.log
	@sleep 5

status:
	@tail -n 1 .stack.log 2>/dev/null || echo "stack not started"
