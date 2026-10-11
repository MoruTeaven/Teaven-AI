job "teaven-ai" {
  datacenters = ["dc1"]
  type        = "service"

  constraint {
    attribute = "${attr.unique.hostname}"
    operator  = "=="
    value     = "xuzhou-mukong"
  }

  group "web" {
    count = 1
    shutdown_delay = "5s"

    network {
      port "http" { static = 3010 to = 3010 }
    }

    restart { attempts = 5 interval = "5m" delay = "10s" mode = "delay" }

    update { max_parallel = 1 health_check = "checks" min_healthy_time = "10s" healthy_deadline = "120s" progress_deadline = "300s" auto_revert = true }

    service {
      name = "teaven-ai" port = "http" provider = "nomad"
      check { name = "alive" type = "http" path = "/health" interval = "10s" timeout = "3s"
        check_restart { limit = 3 grace = "30s" } }
    }

    task "node" {
      driver = "exec"
      config { command = "/bin/sh" args = ["/opt/apps/teaven-ai/start.sh"] }
      resources { cpu = 500 memory = 512 }
    }
  }
}